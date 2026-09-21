import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isSubagentGroupBlock } from '../../../shared/native-chat-types'
import type { NativeChatSubagentEntry } from '../../../shared/native-chat-types'
import {
  codexSubagentGroupBody,
  codexSubagentGroupIdentity
} from '../../codex/codex-subagent-roster'
import type { openAgentSessionJournal } from './journal-store-factory'
import { createTrackedJournalOpener } from './journal-store-test-open'
import { staleSubagentRosterRevisions } from './journal-subagent-liveness'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const GROUP_ID = 'thread-1:turn-1'

let root: string
let clock = 1_000

function tick(): number {
  clock += 1
  return clock
}

const journals = createTrackedJournalOpener()

async function open(overrides: Partial<Parameters<typeof openAgentSessionJournal>[0]> = {}) {
  return journals.open({
    identity: IDENTITY,
    journalDir: root,
    now: tick,
    mintEpoch: () => `epoch-${clock}`,
    ...overrides
  })
}

/** The row as the producer writes it: the structured block plus its twin. */
function rosterRow(agents: NativeChatSubagentEntry[]) {
  return {
    identity: codexSubagentGroupIdentity(GROUP_ID),
    body: codexSubagentGroupBody(GROUP_ID, agents)
  }
}

function renderItem(agents: NativeChatSubagentEntry[]): AgentJournalRenderItem {
  const row = rosterRow(agents)
  return {
    itemId: agentJournalItemKey(row.identity),
    revision: 1,
    body: row.body,
    sequence: 2,
    observedAt: 1
  }
}

function rosterOf(body: AgentJournalRenderItem['body']): NativeChatSubagentEntry[] {
  return body.kind === 'message' ? (body.blocks.find(isSubagentGroupBlock)?.agents ?? []) : []
}

function twinOf(body: AgentJournalRenderItem['body']): string | undefined {
  return body.kind === 'message'
    ? body.blocks.find((block) => block.type === 'text')?.text
    : undefined
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-subagents-'))
  clock = 1_000
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('staleSubagentRosterRevisions', () => {
  it('settles a child the previous host left working, and moves the twin with it', () => {
    const revisions = staleSubagentRosterRevisions([
      renderItem([
        { id: 'a', label: 'read_readme', state: 'working', startedAt: 10 },
        { id: 'b', label: 'read_package', state: 'completed', startedAt: 10, settledAt: 20 }
      ])
    ])

    expect(revisions).toHaveLength(1)
    expect(rosterOf(revisions[0]!.body)).toMatchObject([
      { id: 'a', state: 'unverifiable' },
      { id: 'b', state: 'completed' }
    ])
    // Mobile reads only this sentence, so it may not go on saying `Kicked off`.
    expect(twinOf(revisions[0]!.body)).toBe('Ran 2 subagents (1 unverifiable)')
  })

  // The child stopped being observable at an unknown moment. A stamp taken now
  // would report the time the app was down as how long the child ran.
  it('records no terminal timestamp for a child whose run length is unknown', () => {
    const revisions = staleSubagentRosterRevisions([
      renderItem([{ id: 'a', label: 'read', state: 'working', startedAt: 10 }])
    ])

    expect(rosterOf(revisions[0]!.body)[0]).not.toHaveProperty('settledAt')
  })

  it('owes nothing for a roster whose children all settled', () => {
    expect(
      staleSubagentRosterRevisions([
        renderItem([{ id: 'a', label: 'read', state: 'completed', settledAt: 20 }])
      ])
    ).toEqual([])
  })

  it('leaves rows that carry no roster alone', () => {
    expect(
      staleSubagentRosterRevisions([
        {
          itemId: 'orca:plain',
          revision: 1,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'hi' }] },
          sequence: 2,
          observedAt: 1
        }
      ])
    ).toEqual([])
  })

  // Appending under a fresh identity would add a second row rather than revise
  // the one on disk, so an unaddressable key is left exactly as it is.
  it('skips a row whose key cannot be parsed back to its identity', () => {
    expect(
      staleSubagentRosterRevisions([
        { ...renderItem([{ id: 'a', label: 'r', state: 'working' }]), itemId: 'not-a-key' }
      ])
    ).toEqual([])
  })
})

describe('journal reopen after the writing host is gone', () => {
  it('settles a persisted working roster to unverifiable, while the live row still reads working', async () => {
    const live = await open()
    const row = rosterRow([
      { id: 'a', label: 'read_readme', state: 'working', startedAt: 10 },
      { id: 'b', label: 'read_package', state: 'working', startedAt: 10 }
    ])
    await live.appendItem(row.identity, row.body, { fence: 0 })

    // Still the writing host: it can see the children, so the row says so.
    const beforeRestart = live.snapshot().items.at(-1)!
    expect(rosterOf(beforeRestart.body)).toMatchObject([{ state: 'working' }, { state: 'working' }])
    expect(twinOf(beforeRestart.body)).toBe('Kicked off 2 subagents')

    // The host dies without ever settling them — no `ended`, so no session sweep.
    await live.close()

    const reopened = await open()
    const afterRestart = reopened.snapshot().items.at(-1)!
    expect(afterRestart.itemId).toBe(beforeRestart.itemId)
    expect(rosterOf(afterRestart.body)).toMatchObject([
      { id: 'a', state: 'unverifiable' },
      { id: 'b', state: 'unverifiable' }
    ])
    expect(twinOf(afterRestart.body)).toBe('Ran 2 subagents (2 unverifiable)')
  })

  it('revises the row in place rather than appending a second one', async () => {
    const live = await open()
    const row = rosterRow([{ id: 'a', label: 'read', state: 'working', startedAt: 10 }])
    await live.appendItem(row.identity, row.body, { fence: 0 })
    const before = live.snapshot().items.length
    await live.close()

    const reopened = await open()
    expect(reopened.snapshot().items).toHaveLength(before)
    expect(reopened.snapshot().items.at(-1)?.revision).toBe(2)
  })

  it('writes nothing on a second reopen once every child is settled', async () => {
    const live = await open()
    const row = rosterRow([{ id: 'a', label: 'read', state: 'working', startedAt: 10 }])
    await live.appendItem(row.identity, row.body, { fence: 0 })
    await live.close()

    const once = await open()
    const revision = once.snapshot().items.at(-1)?.revision
    await once.close()

    const twice = await open()
    expect(twice.snapshot().items.at(-1)?.revision).toBe(revision)
  })
})
