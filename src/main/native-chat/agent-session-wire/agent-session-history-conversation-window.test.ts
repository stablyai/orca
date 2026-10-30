import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalProducerLinkage,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryRequest
} from '../../../shared/agent-session-wire'
import { serializeRemoteRuntimePayload } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  readAgentSessionHistory,
  readAgentSessionHydrationPage
} from './agent-session-history-page'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { foldSubagentItems } from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import {
  subagentJournalBody,
  subagentJournalItemIdentity
} from '../agent-session-journal/journal-subagent-item'

// Window on session-owned rows; include subagent rows without letting bursts crowd out conversation.

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

const child: AgentJournalProducerLinkage = { agentId: 'task-1', producerKind: 'agent' }
const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000
let ordinal = 0
let journal: AgentSessionJournal

function said(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

async function appendRoster(agentIds: string[]): Promise<void> {
  ordinal += 1
  await journal.appendItem(
    { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
    {
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: `group-${ordinal}`,
          agents: agentIds.map((id) => ({ id, label: `run ${id}`, state: 'working' as const }))
        }
      ]
    },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

async function append(texts: string[], linkage: AgentJournalProducerLinkage = {}): Promise<void> {
  for (const text of texts) {
    ordinal += 1
    await journal.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal },
      said(text),
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE, ...linkage }
    )
  }
}

const named = (prefix: string, from: number, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${from + index}`)

function textsOf(page: AgentSessionHistoryPage): string[] {
  return page.items.map((entry) =>
    entry.body.kind === 'message' && entry.body.blocks[0]?.type === 'text'
      ? entry.body.blocks[0].text
      : ''
  )
}

function read(request: Omit<AgentSessionHistoryRequest, 'sessionId'>): AgentSessionHistoryPage {
  const result = readAgentSessionHistory(journal, { sessionId: 'session-1', ...request })
  if (!result.ok) {
    throw new Error(`expected a page, got reset ${result.reset}`)
  }
  serializeRemoteRuntimePayload(result.page)
  return result.page
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-wire-history-window-'))
  clock = 1_000
  ordinal = 0
  journal = await journals.open({
    identity: IDENTITY,
    stateDirectory: root,
    now: () => ++clock,
    mintEpoch: () => 'epoch-1'
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('a history page over a session with a subagent', () => {
  it("counts the session's own rows and carries the subagent's rows between them", async () => {
    await append(named('own-', 1, 5))
    await append(named('child-', 1, 300), child)
    await append(['own-6'])

    const tail = read({ direction: 'tail', limit: 3 })
    expect(textsOf(tail)).toEqual(['own-4', 'own-5', ...named('child-', 1, 300), 'own-6'])
    expect(tail.hasOlder).toBe(true)

    const older = read({ direction: 'before', cursor: tail.window.nextCursor, limit: 3 })
    expect(textsOf(older)).toEqual(['own-1', 'own-2', 'own-3'])
    expect(older.hasOlder).toBe(false)
    expect(older.hasNewer).toBe(true)
  })

  it('opens on the conversation, not a page of the burst that followed it', async () => {
    await append(named('own-', 1, 5))
    await append(named('child-', 1, 300), child)

    const page = readAgentSessionHydrationPage(journal)

    expect(textsOf(page)).toEqual([...named('own-', 1, 5), ...named('child-', 1, 300)])
    expect(page.hasOlder).toBe(false)
  })

  it('reaches back to the start, not a page of the subagent alone, once fewer own rows remain', async () => {
    await append(named('child-', 1, 3), child)
    await append(named('own-', 1, 2))

    const tail = read({ direction: 'tail', limit: 5 })

    expect(textsOf(tail)).toEqual([...named('child-', 1, 3), 'own-1', 'own-2'])
    expect(tail.hasOlder).toBe(false)
  })

  it("carries a fan-out's subagent rows without counting them as conversation", async () => {
    await append(named('own-', 1, 5))
    for (const id of named('task-', 1, 300)) {
      await journal.appendItem(
        subagentJournalItemIdentity(id),
        subagentJournalBody({ type: 'subagent', id, label: id, state: 'working', groupId: 't' }),
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    await append(['own-6'])

    const tail = read({ direction: 'tail', limit: 3 })

    expect(textsOf(tail)).toEqual([
      'own-4',
      'own-5',
      ...named('Kicked off subagent task-', 1, 300),
      'own-6'
    ])
    expect(tail.hasOlder).toBe(true)
  })

  it("loads an older page without renumbering a turn's subagents or moving their row", async () => {
    const audit = async (id: string): Promise<void> => {
      await journal.appendItem(
        subagentJournalItemIdentity(id),
        subagentJournalBody({
          type: 'subagent',
          id,
          label: 'Audit',
          state: 'working',
          groupId: 't'
        }),
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    }
    await append(named('own-', 1, 3))
    await audit('a')
    await append(named('own-', 4, 5))
    await audit('b')
    await append(named('own-', 9, 2))
    await audit('c')
    await append(['own-11'])
    const folded = (pages: AgentSessionHistoryPage[]) =>
      foldSubagentItems(
        pages
          .flatMap((page) => page.items)
          .map((entry) => ({
            id: entry.itemId,
            role: 'system' as const,
            timestamp: null,
            source: 'transcript' as const,
            blocks: entry.body.kind === 'message' ? entry.body.blocks : []
          }))
      ).flatMap((row) =>
        row.blocks.flatMap((block) =>
          block.type === 'subagent-group'
            ? [{ row: row.id, labels: block.agents.map((agent) => `${agent.id}=${agent.label}`) }]
            : []
        )
      )

    const tail = read({ direction: 'tail', limit: 5 })
    const older = read({ direction: 'before', cursor: tail.window.nextCursor, limit: 5 })

    expect(textsOf(tail)[0]).toBe('Kicked off subagent Audit')
    expect(textsOf(older)).toEqual(named('own-', 1, 3))
    expect(folded([tail])).toEqual([
      { row: 'orca:subagent%3Aa', labels: ['a=Audit', 'b=Audit 2', 'c=Audit 3'] }
    ])
    expect(folded([older, tail])).toEqual(folded([tail]))
  })

  it('reaches back for a first sibling no further than one more page of conversation', async () => {
    for (const [id, own] of [
      ['a', named('own-', 1, 10)],
      ['b', ['own-11']]
    ] as const) {
      await journal.appendItem(
        subagentJournalItemIdentity(id),
        subagentJournalBody({
          type: 'subagent',
          id,
          label: id,
          state: 'working',
          groupId: 'thread'
        }),
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await append([...own])
    }

    const tail = read({ direction: 'tail', limit: 2 })

    expect(textsOf(tail)).toEqual(['own-8', 'own-9', 'own-10', 'Kicked off subagent b', 'own-11'])
  })

  it('still bounds a page by bytes, and paging back still reaches every row', async () => {
    const large = 'x'.repeat(250 * 1024)
    await append(['own-1'])
    await append(named(`${large}:`, 1, 20), child)
    await append(['own-2'])

    const tail = read({ direction: 'tail', limit: 40 })
    expect(tail.hasOlder).toBe(true)
    const seen = [...tail.items]
    let page = tail
    for (let guard = 0; page.hasOlder; guard += 1) {
      expect(guard).toBeLessThan(30)
      page = read({ direction: 'before', cursor: page.window.nextCursor, limit: 40 })
      expect(page.items.length).toBeGreaterThan(0)
      seen.unshift(...page.items)
    }
    const sequences = seen.map((entry) => entry.sequence)
    expect(sequences).toHaveLength(22)
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(new Set(sequences).size).toBe(22)
  })
})

describe('a history page names the subagents whose roster row is older than it', () => {
  it('names a subagent whose roster row is just above the opening page', async () => {
    await append(['own-1'])
    await appendRoster(['task-1'])
    await append(['child-1'], child)
    await append(named('own-', 2, 200))
    await append(['child-2'], child)

    const page = readAgentSessionHydrationPage(journal)

    expect(textsOf(page)[0]).toBe('own-2')
    expect(page.subagentRoster?.map((named) => [named.entry.id, named.entry.label])).toEqual([
      ['task-1', 'run task-1']
    ])
  })

  it('names a subagent whose own row is above the opening page, by that row', async () => {
    await append(['own-1'])
    await journal.appendItem(
      subagentJournalItemIdentity('task-1'),
      subagentJournalBody({
        type: 'subagent',
        id: 'task-1',
        label: 'run task-1',
        state: 'working',
        groupId: 'turn-1',
        run: 'call-1'
      }),
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await append(named('own-', 2, 200))
    await append(['child-2'], child)

    const page = readAgentSessionHydrationPage(journal)

    expect(page.subagentRoster).toEqual([
      expect.objectContaining({
        itemId: 'orca:subagent%3Atask-1',
        entry: { id: 'task-1', label: 'run task-1', state: 'working' }
      })
    ])
  })

  it('names nothing beside the items when the page carries the roster row', async () => {
    await append(['own-1'])
    await appendRoster(['task-1'])
    await append(['child-1'], child)

    expect(readAgentSessionHydrationPage(journal).subagentRoster).toBeUndefined()
    expect(read({ direction: 'tail', limit: 5 }).subagentRoster).toBeUndefined()
  })

  it('names a bounded number of subagents', async () => {
    const agents = named('task-', 1, 70)
    await appendRoster(agents)
    await append(['own-1'])
    for (const agentId of agents) {
      await append([`${agentId} says`], { agentId, producerKind: 'agent' })
    }
    await append(['own-2'])

    const tail = read({ direction: 'tail', limit: 2 })

    expect(textsOf(tail)[0]).toBe('own-1')
    expect(tail.subagentRoster).toHaveLength(64)
  })
})

describe('a history page over a session with no subagent rows', () => {
  it('serves exactly the newest rows per page, as before', async () => {
    await append(named('own-', 1, 23))

    const pages: string[][] = []
    let page = read({ direction: 'tail', limit: 5 })
    pages.push(textsOf(page))
    while (page.hasOlder) {
      page = read({ direction: 'before', cursor: page.window.nextCursor, limit: 5 })
      pages.push(textsOf(page))
    }

    expect(pages).toEqual([
      named('own-', 19, 5),
      named('own-', 14, 5),
      named('own-', 9, 5),
      named('own-', 4, 5),
      named('own-', 1, 3)
    ])
  })

  it('opens on the newest 200 rows, as before', async () => {
    await append(named('own-', 1, 250))

    const page = readAgentSessionHydrationPage(journal)

    expect(textsOf(page)).toEqual(named('own-', 51, 200))
    expect(page.hasOlder).toBe(true)
    expect(page).not.toHaveProperty('subagentRoster')
  })
})
