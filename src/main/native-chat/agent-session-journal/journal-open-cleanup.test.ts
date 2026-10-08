import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalCursor
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { backgroundTaskFallbackText } from '../../../shared/native-chat-background-task-row'
import {
  isBackgroundTaskBlock,
  isSubagentGroupBlock,
  type NativeChatBackgroundTaskBlock
} from '../../../shared/native-chat-types'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session-wire'
import { AgentSessionSubscribers } from '../agent-session-wire/structured-agent-session-subscribers'
import {
  codexSubagentGroupBody,
  codexSubagentGroupIdentity
} from '../../codex/codex-subagent-roster'
import {
  createTrackedJournalOpener,
  loadTestJournal,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { AgentSessionJournal } from './journal-store'

const identity = {
  sessionId: 'session-1',
  workspaceId: 'folder-workspace',
  hostId: 'host-1',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread-1')
}
const rosterIdentity = codexSubagentGroupIdentity('group-1')
const working = codexSubagentGroupBody('group-1', [
  { id: 'child-1', label: 'Read', state: 'working' }
])
const options = { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
const journals = createTrackedJournalOpener()
let root: string

const open = () => journals.open({ identity, stateDirectory: root })

function failCleanup(): void {
  openTestJournalHostDatabase(root).db.exec(`
    CREATE TRIGGER fail_roster_cleanup BEFORE INSERT ON journal_rows
    WHEN NEW.row_json LIKE '%unverifiable%'
    BEGIN SELECT RAISE(ABORT, 'roster cleanup unavailable'); END;
  `)
}

function restoreCleanup(): void {
  openTestJournalHostDatabase(root).db.exec('DROP TRIGGER fail_roster_cleanup')
}

function persistedRoster() {
  return loadTestJournal(root, identity.sessionId)?.state.items.values().next().value
}

/** What a client resuming from `cursor` is sent when it subscribes. */
function subscribeFrom(
  journal: AgentSessionJournal,
  cursor: AgentJournalCursor
): AgentSessionSubscribeEvent[] {
  const events: AgentSessionSubscribeEvent[] = []
  new AgentSessionSubscribers().open({
    id: 'reconnecting-client',
    sessionId: identity.sessionId,
    journal,
    cursor,
    fence: 0,
    emit: (event) => {
      events.push(event)
    }
  })()
  return events
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-open-cleanup-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('journal open cleanup', () => {
  it('opens readable history and accepts a write when stale roster persistence fails', async () => {
    const live = await open()
    await live.appendItem(rosterIdentity, working, options)
    const before = live.cursor()
    await live.close()
    failCleanup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const reopened = await open()
    const roster = reopened.snapshot().items[0]
    expect(roster?.body).toMatchObject({
      blocks: expect.arrayContaining([
        expect.objectContaining({
          agents: [expect.objectContaining({ id: 'child-1', state: 'unverifiable' })]
        })
      ])
    })
    expect(reopened.cursor()).toEqual(before)
    expect(warn).toHaveBeenCalledOnce()
    expect(persistedRoster()?.body).toEqual(working)

    const attempts = vi.spyOn(reopened, 'appendResolvedItem')
    await reopened.appendSubmission({
      clientMessageId: 'new-message',
      payloadFingerprint: 'new-message-fingerprint',
      handoverRecorded: true,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Keep working' }] },
      fence: 0
    })
    expect(reopened.submission('new-message')).toMatchObject({
      clientMessageId: 'new-message',
      handoverRecorded: true
    })
    // The commit retried the cleanup; it failed again without another log line.
    await vi.waitFor(() => expect(attempts).toHaveBeenCalled())
    await Promise.allSettled(attempts.mock.results.map((result) => result.value))
    await reopened.readInOrder(() => undefined)
    expect(warn).toHaveBeenCalledOnce()
    expect(reopened.hasUnpersistedReopenedLiveWork()).toBe(true)

    restoreCleanup()
    await reopened.appendItem(
      { provider: 'orca', clientMessageId: 'activity' },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Still working' }] },
      options
    )
    await vi.waitFor(() => {
      expect(persistedRoster()?.revision).toBe(2)
    })
    expect(persistedRoster()?.body).toEqual(roster?.body)
    expect(reopened.hasUnpersistedReopenedLiveWork()).toBe(false)
  })

  it('settles a live background task in the fold when its cleanup write fails', async () => {
    const task: NativeChatBackgroundTaskBlock = {
      type: 'background-task',
      taskId: 'task-1',
      kind: 'command',
      label: 'sleep 20',
      state: 'working',
      startedAt: 10
    }
    const live = await open()
    await live.appendItem(
      { provider: 'orca', clientMessageId: `claude-background-task:${task.taskId}` },
      {
        kind: 'message',
        role: 'system',
        blocks: [{ type: 'text', text: backgroundTaskFallbackText(task) }, task]
      },
      options
    )
    await live.close()
    failCleanup()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const reopened = await open()
    const body = reopened.snapshot().items[0]?.body
    expect(body?.kind === 'message' && body.blocks.find(isBackgroundTaskBlock)).toMatchObject({
      state: 'unverifiable'
    })
    expect(reopened.hasUnpersistedReopenedLiveWork()).toBe(true)
  })

  it('sends a resuming client a snapshot only while the cleanup is unwritten', async () => {
    const live = await open()
    await live.appendItem(rosterIdentity, working, options)
    const before = live.cursor()
    await live.close()
    failCleanup()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const reopened = await open()
    const settled = reopened.snapshot().items[0]
    const [unwritten] = subscribeFrom(reopened, before)
    expect(unwritten?.type).toBe('snapshot')
    expect(unwritten?.type === 'snapshot' && unwritten.page.items).toContainEqual(settled)

    restoreCleanup()
    await reopened.appendItem(
      { provider: 'orca', clientMessageId: 'activity' },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Still working' }] },
      options
    )
    await vi.waitFor(() => expect(reopened.hasUnpersistedReopenedLiveWork()).toBe(false))
    const written = subscribeFrom(reopened, before)
    expect(written.map((event) => event.type)).not.toContain('snapshot')
    expect(
      written.flatMap((event) => (event.type === 'batch' ? event.batch.items : []))
    ).toContainEqual(
      expect.objectContaining({ itemId: settled?.itemId, revision: 2, body: settled?.body })
    )
  })

  it('re-derives failed cleanup on a later open without a durable retry flag', async () => {
    const live = await open()
    await live.appendItem(rosterIdentity, working, options)
    await live.close()
    failCleanup()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failed = await open()
    await failed.close()

    restoreCleanup()
    const recovered = await open()
    expect(recovered.snapshot().items[0]?.revision).toBe(2)
    await recovered.close()
    const again = await open()
    expect(again.snapshot().items[0]?.revision).toBe(2)
  })

  it('abandons an old cleanup revision when new provider evidence supersedes it', async () => {
    const live = await open()
    await live.appendItem(rosterIdentity, working, options)
    await live.close()
    failCleanup()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reopened = await open()
    restoreCleanup()

    await reopened.appendItem(rosterIdentity, working, options)
    await reopened.readInOrder(() => undefined)
    const latest = reopened.snapshot().items[0]
    expect(latest?.revision).toBe(2)
    expect(
      latest?.body.kind === 'message' && latest.body.blocks.find(isSubagentGroupBlock)?.agents
    ).toMatchObject([{ id: 'child-1', state: 'working' }])
    expect(reopened.hasUnpersistedReopenedLiveWork()).toBe(false)
  })
})
