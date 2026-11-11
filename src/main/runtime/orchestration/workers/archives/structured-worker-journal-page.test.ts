import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemIdentity } from '../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  type AgentJournalItemBody,
  type AgentJournalProducerLinkage,
  AGENT_JOURNAL_THREAD_SCOPE
} from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionHistoryRequest } from '../../../../../shared/agent-session/agent-session-wire'
import { createTrackedJournalOpener } from '../../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionJournal } from '../../../../native-chat/agent-session-journal/journal-store'
import type { AgentSessionHistoryScope } from '../../../../native-chat/agent-session-wire/publication/history/agent-session-history-page'
import { readStructuredAgentSessionHistoryResult } from '../../../../native-chat/agent-session-wire/publication/history/structured-agent-session-history-result'
import {
  readStructuredJournalPage,
  STRUCTURED_JOURNAL_PAGE_LIMIT
} from './structured-worker-journal-page'
import { readStructuredLineageArchiveJournal } from './structured-worker-journal-archive'
import { claudeProviderHandle } from '../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const host = vi.hoisted(() => {
  const state: { journal: AgentSessionJournal | null } = { journal: null }
  return state
})

// The host's read, over a real journal: only the conversation lookup is stubbed.
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => ({
      history: async (request: AgentSessionHistoryRequest, scope?: AgentSessionHistoryScope) =>
        readStructuredAgentSessionHistoryResult({
          journal: host.journal!,
          record: null,
          request,
          scope
        })
    })
  })
)

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
  host.journal = await journals.open({
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
})

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

  it('archives every row that fits the byte bound, not just the newest page', async () => {
    for (let index = 0; index < 250; index += 1) {
      await append(`worker-${index}`)
    }

    const page = await readStructuredLineageArchiveJournal(['session-1'])

    expect(page?.items).toHaveLength(250)
    expect(page?.items[0]?.body).toEqual(said('worker-0'))
    expect(page?.items.at(-1)?.body).toEqual(said('worker-249'))
    expect(page?.hasOlder).toBe(false)
  })
})
