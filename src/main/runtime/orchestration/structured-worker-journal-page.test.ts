import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalProducerLinkage
} from '../../../shared/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryRequest } from '../../../shared/agent-session-wire'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import type { AgentSessionJournal } from '../../native-chat/agent-session-journal/journal-store'
import type { AgentSessionHistoryScope } from '../../native-chat/agent-session-wire/agent-session-history-page'
import { readStructuredAgentSessionHistoryResult } from '../../native-chat/agent-session-wire/structured-agent-session-history-result'
import {
  readStructuredJournalPage,
  STRUCTURED_JOURNAL_PAGE_LIMIT
} from './structured-worker-journal-page'
import {
  projectStructuredItemsToNativeChat,
  projectStructuredAgentSessionStatusSummary
} from '../../../shared/structured-agent-session-projection'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import { structuredAgentSessionWorkingAtStop } from '../../native-chat/agent-session-wire/structured-agent-session-working-at-teardown'
import { claudeProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const host = vi.hoisted(() => {
  const state: { journal: AgentSessionJournal | null } = { journal: null }
  return state
})

// The host's read, over a real journal: only the conversation lookup is stubbed.
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => ({
    history: async (request: AgentSessionHistoryRequest, scope?: AgentSessionHistoryScope) =>
      readStructuredAgentSessionHistoryResult({
        journal: host.journal!,
        record: null,
        request,
        scope
      })
  })
}))

const journals = createTrackedJournalOpener()
let root: string
let clock = 1_000
let ordinal = 0

function said(text: string): AgentJournalItemBody {
  return { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
}

async function append(text: string, linkage: AgentJournalProducerLinkage = {}): Promise<void> {
  ordinal += 1
  const identity: AgentJournalItemIdentity = {
    provider: 'claude',
    sessionId: 'claude-1',
    uuid: `uuid-${ordinal}`
  }
  await host.journal!.appendItem(identity, said(text), {
    fence: 1,
    turnScope: AGENT_JOURNAL_THREAD_SCOPE,
    ...linkage
  })
}

const subagent: AgentJournalProducerLinkage = { agentId: 'task-1', producerKind: 'agent' }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-worker-journal-page-'))
  clock = 1_000
  ordinal = 0
  host.journal = await openJournal()
})

function openJournal() {
  return journals.open({
    identity: {
      sessionId: 'session-1',
      workspaceId: 'ws-1',
      hostId: 'host-1',
      agent: 'claude',
      providerHandle: claudeProviderHandle('claude-1', null)
    },
    stateDirectory: root,
    now: () => ++clock,
    mintEpoch: () => 'epoch-1'
  })
}

afterEach(async () => {
  await journals.closeAll()
  host.journal = null
  await rm(root, { recursive: true, force: true })
})

describe("a worker's journal page", () => {
  it("is the newest page of the worker's own rows, however many subagent rows are newer", async () => {
    await append('worker-older')
    await append('worker-newest')
    for (let index = 0; index < STRUCTURED_JOURNAL_PAGE_LIMIT + 60; index += 1) {
      await append(`child-${index}`, subagent)
    }

    const before = await readStructuredJournalPage('session-1')
    await host.journal!.close()
    host.journal = await journals.open({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'ws-1',
        hostId: 'host-1',
        agent: 'claude',
        providerHandle: claudeProviderHandle('claude-1', null)
      },
      stateDirectory: root,
      now: () => ++clock
    })
    const page = await readStructuredJournalPage('session-1')
    expect(page).toStrictEqual(before)

    expect(page?.items.map((item) => item.body)).toEqual([
      said('worker-older'),
      said('worker-newest')
    ])
    expect(page?.hasOlder).toBe(false)
  })

  it('says there is older history when the worker has more of its own rows than a page', async () => {
    for (let index = 0; index < STRUCTURED_JOURNAL_PAGE_LIMIT + 5; index += 1) {
      await append(`worker-${index}`)
      await append(`child-${index}`, subagent)
    }

    const page = await readStructuredJournalPage('session-1')

    expect(page?.items).toHaveLength(STRUCTURED_JOURNAL_PAGE_LIMIT)
    expect(page?.items.every((item) => item.agentId === undefined)).toBe(true)
    expect(page?.items.at(-1)?.body).toEqual(said(`worker-${STRUCTURED_JOURNAL_PAGE_LIMIT + 4}`))
    expect(page?.hasOlder).toBe(true)
  })
})

it.each(['normal', 'empty-earlier'] as const)(
  'projects %s text history through worker, public, activity and quit consumers after reopen',
  async (historyShape) => {
    const journal = host.journal!
    const committedRows: JournalRow[] = []
    journal.observeCommits((rows) => committedRows.push(...(rows ?? [])))
    const turn = { provider: 'claude', sessionId: 'claude-1', uuid: 'turn' } as const
    const scope = { kind: 'turn', turnItemId: 'claude:claude-1:turn' } as const
    await journal.appendItem(
      turn,
      { kind: 'turn', turnId: 'turn', state: 'running' },
      {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    )
    const reply = { provider: 'claude', sessionId: 'claude-1', uuid: 'reply' } as const
    const values =
      historyShape === 'empty-earlier'
        ? ['', '', 'complete answer']
        : ['first', 'first more', 'complete answer']
    for (const value of values) {
      await journal.appendItem(reply, said(value), {
        fence: 1,
        ownerFence: 1,
        executionOwner: 1,
        turnScope: scope
      })
    }
    const rows = journal.readSince({ epoch: journal.epoch, sequence: 0 })
    expect(rows.ok).toBe(true)
    if (!rows.ok) {
      throw new Error('missing rows')
    }
    expect(
      committedRows
        .filter((row) => row.kind === 'item' && row.itemId === 'claude:claude-1:reply')
        .map((row) => (row.kind === 'item' ? row.body : null))
    ).toEqual(values.map(said))
    expect(
      rows.rows.filter(
        (row) => row.kind === 'outcome' && row.itemIds.includes('claude:claude-1:reply')
      )
    ).toHaveLength(values.length)
    const first = committedRows.find(
      (row) => row.kind === 'item' && row.itemId === 'claude:claude-1:reply'
    )
    expect(first).toMatchObject({
      kind: 'item',
      revision: 1,
      turnScope: scope,
      ownerFence: 1,
      executionOwner: 1,
      body: said(values[0])
    })
    expect(journal.item('claude:claude-1:reply')).toMatchObject({
      sequence: first?.seq,
      observedAt: first?.ts,
      turnScope: scope
    })
    const expected = journal.snapshot().items
    const activity = journal.lastProviderActivityAt(1)
    expect(activity).toBe(clock)
    await journals.closeAll()
    host.journal = await openJournal()
    const reopened = host.journal
    expect(reopened.snapshot().items).toEqual(expected)
    expect(reopened.lastProviderActivityAt(1)).toBe(activity)
    expect(reopened.publicRead().snapshot.items).toEqual(expected)
    const history = readStructuredAgentSessionHistoryResult({
      journal: reopened,
      record: null,
      request: {
        sessionId: 'session-1',
        direction: 'after',
        cursor: { epoch: reopened.epoch, sequence: 0 }
      }
    })
    const state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
      type: 'history-page',
      page: history.page
    })
    expect(state.items).toEqual(expected)
    const page = await readStructuredJournalPage('session-1')
    expect(page?.items).toEqual(expected)
    for (const items of [state.items, page!.items]) {
      expect(
        projectStructuredItemsToNativeChat(items).flatMap((message) => message.blocks)
      ).toEqual([{ type: 'text', text: 'complete answer' }])
      expect(projectStructuredAgentSessionStatusSummary(items, [])).toMatchObject({
        status: 'working'
      })
    }
    expect(
      structuredAgentSessionWorkingAtStop({
        sessionId: 'session-1',
        session: { journal: reopened, child: { fence: 1, phase: 'ready' } },
        getRecord: () => ({
          providerHandleChain: [
            {
              linkId: 'link',
              handle: claudeProviderHandle('claude-1', null),
              origin: 'created',
              mintedAtFence: 1,
              observedAt: 1000
            }
          ]
        }),
        childWork: () => [],
        childWorkOpen: () => false,
        trigger: 'quit',
        teardownId: 'test-quit',
        now: clock
      })
    ).toMatchObject({
      work: { kind: 'turn', id: 'turn' },
      journalCursor: reopened.cursor(),
      activity: { state: 'working', prompts: [], tasks: [] }
    })
  }
)
