import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  type AgentJournalItemBody,
  type AgentJournalProducerLinkage,
  AGENT_JOURNAL_THREAD_SCOPE
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  AgentSessionHistoryPage,
  AgentSessionHistoryRequest
} from '../../../../../../shared/agent-session/agent-session-wire'
import { serializeRemoteRuntimePayload } from '../../../../../../shared/remote-runtime/remote-runtime-memory-limits'
import { createTrackedJournalOpener } from '../../../../agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { readAgentSessionHistory } from '../agent-session-history-page'
import { codexProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

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
})
