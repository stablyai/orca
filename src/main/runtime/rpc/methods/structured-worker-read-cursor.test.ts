/** Read a real journal between writes: messages revised in place, anywhere behind the cursor, must reach a polling reader exactly once per change. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session-conversation-view'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentSessionJournalIdentity
} from '../../../../shared/agent-session-journal-types'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session-record.test-fixture'
import { codexProviderHandle } from '../../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionHistoryRequest } from '../../../../shared/agent-session-wire'
import type { AgentSessionJournal } from '../../../native-chat/agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  readAgentSessionHistory,
  type AgentSessionHistoryScope
} from '../../../native-chat/agent-session-wire/agent-session-history-page'
import type { StructuredWorkerIdentity } from '../../structured-worker-identity'

const hostRef: { current: unknown } = { current: null }

vi.mock('../../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const { readStructuredWorkerJournal } = await import('./orchestration-structured-worker-lifecycle')

const IDENTITY: StructuredWorkerIdentity = {
  handle: 'structworker_1',
  sessionId: 'session-1',
  agent: 'codex',
  paneKey: 'structured-agent-session-session-1:11111111-1111-4111-a111-111111111111',
  processIncarnation: 'structured:session-1',
  worktreeId: 'wt_1',
  hostScope: { kind: 'local', hostId: 'local' }
}
const JOURNAL_IDENTITY: AgentSessionJournalIdentity = {
  sessionId: IDENTITY.sessionId,
  workspaceId: 'wt_1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: codexProviderHandle('01a08cc2-f96e-76d0-bb74-88b9bc0b03fc')
}

const journals = createTrackedJournalOpener()
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-worker-read-cursor-'))
  journal = await journals.open({ identity: JOURNAL_IDENTITY, stateDirectory: root })
  hostRef.current = {
    deps: {
      store: {
        getConversation: () =>
          agentSessionConversationView(
            agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: IDENTITY.sessionId }))
          )
      }
    },
    hasSession: () => true,
    // As the host: only an explicit `false` replays rows instead of resetting normalized history.
    history: async (
      request: AgentSessionHistoryRequest,
      scope?: AgentSessionHistoryScope,
      replaceNormalizedHistory = true
    ) =>
      readAgentSessionHistory(journal, request, {
        scope,
        rowReplay: replaceNormalizedHistory === false
      })
  }
})

afterEach(async () => {
  hostRef.current = null
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

const say = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})

/** Writing the same id again revises that message in place, as streaming and tool results do. */
async function write(id: string, body: AgentJournalItemBody): Promise<void> {
  await journal.appendItem({ provider: 'orca', clientMessageId: id }, body, {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
}

function read(cursor?: string, limit?: number) {
  return readStructuredWorkerJournal({
    identity: IDENTITY,
    dispatchId: 'd1',
    workerState: 'ready',
    liveness: 'live',
    agent: 'codex',
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit })
  })
}

function textsOf(result: Awaited<ReturnType<typeof read>>): string[] {
  return result.transcript.messages.map((entry) =>
    entry.blocks.map((block) => ('text' in block ? block.text : '')).join('')
  )
}

describe('the structured worker-read cursor over a live journal', () => {
  it('starts at the newest messages and says older ones are not pageable', async () => {
    await write('a', say('a'))
    await write('b', say('b'))
    await write('c', say('c'))
    const first = await read(undefined, 2)
    expect(textsOf(first)).toEqual(['b', 'c'])
    expect(first.clipping).toEqual(['message_limit_or_scan_window'])

    const second = await read(first.cursor)
    expect(textsOf(second)).toEqual([])
    expect(second.contentComplete).toBe(true)
  })

  it('re-sends any delivered message revised since, not just the last one', async () => {
    // A tool call gaining its result behind a later message was lost by a last-message-only cursor.
    await write('call', say('running…'))
    await write('note', say('meanwhile'))
    const first = await read()
    expect(textsOf(first)).toEqual(['running…', 'meanwhile'])

    await write('call', say('done: 42'))
    await write('next', say('next'))
    const second = await read(first.cursor)
    expect(textsOf(second)).toEqual(['done: 42', 'next'])
    expect(second.transcript.messages[0]?.id).toBe(first.transcript.messages[0]?.id)
    expect(second.sourceIdentity).toBe(first.sourceIdentity)
  })

  it('keeps up with a reply saved many times while it streams', async () => {
    // A page bounded by journal writes covered seconds of streaming and fell behind the worker.
    await write('reply', say(''))
    const first = await read()
    for (let length = 1; length <= 120; length++) {
      await write('reply', say('x'.repeat(length)))
    }
    await write('done', say('done'))
    const second = await read(first.cursor)
    expect(textsOf(second)).toEqual(['x'.repeat(120), 'done'])
    expect(second.contentComplete).toBe(true)
  })

  it('keeps following a journal whose display history was normalized', async () => {
    // Normalized history made the host's default catch-up reset on every read.
    await write('call', say('running…'))
    await write('note', say('meanwhile'))
    const first = await read()
    const publicRead = journal.publicRead.bind(journal)
    vi.spyOn(journal, 'publicRead').mockImplementation(() => ({
      ...publicRead(),
      normalizationKey: 'normalized'
    }))
    await write('call', say('done: 42'))
    const second = await read(first.cursor)
    expect(textsOf(second)).toEqual(['done: 42'])
    expect(second.warnings).toEqual([])
  })

  it('starts over at the newest messages when one save is too large to send', async () => {
    // A cursor advanced past a whole save whose messages the size limit had dropped.
    await write('a', say('a'))
    const first = await read()
    const block = { type: 'text' as const, text: 'x'.repeat(1_200) }
    await journal.appendLifecycleBatch({
      settlementId: 'big',
      fence: 1,
      mutations: Array.from({ length: 100 }, (_, index) => ({
        kind: 'item' as const,
        identity: { provider: 'orca' as const, clientMessageId: `big-${index}` },
        body: {
          kind: 'message' as const,
          role: 'assistant' as const,
          blocks: Array.from({ length: 6 }, () => ({ ...block }))
        },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }))
    })
    const second = await read(first.cursor)
    expect(second.warnings[0]).toMatch(/update_too_large.*newest messages/)
    expect(second.transcript.messages.at(-1)?.id).toContain('big-99')

    await write('after', say('after'))
    expect(textsOf(await read(second.cursor))).toEqual(['after'])
  })

  it('pages many writes forward exactly once', async () => {
    await write('a', say('a'))
    const first = await read()
    await write('b', say('b'))
    await write('c', say('c'))
    const second = await read(first.cursor, 1)
    expect(second.transcript.limited).toBe(true)
    const third = await read(second.cursor, 1)
    expect(third.contentComplete).toBe(true)
    expect([...textsOf(first), ...textsOf(second), ...textsOf(third)]).toEqual(['a', 'b', 'c'])
  })

  it('refuses a cursor minted for another session of the lineage', async () => {
    await write('a', say('a'))
    const first = await read()
    await expect(
      readStructuredWorkerJournal({
        identity: { ...IDENTITY, paneKey: 'structured-agent-session-other:x' },
        dispatchId: 'd1',
        workerState: 'ready',
        liveness: 'live',
        agent: 'codex',
        cursor: first.cursor
      })
    ).rejects.toThrow(/source changed/i)
  })
})
