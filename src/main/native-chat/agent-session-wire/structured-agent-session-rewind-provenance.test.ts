import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { structuredRewindCut } from './structured-rewind-cut'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
const DEAD = 1
const LIVE = 3

function codexItem(turnId: string, ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId, ordinal }
}
const TURN = codexItem('turn-dead', 0)
const PROMPT = codexItem('turn-dead', 1)
const REPLY = codexItem('turn-dead', 2)
const UNDONE = codexItem('turn-undone', 0)
const PENDING = {
  state: 'pending' as const,
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}
const REPLY_BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'partial' }]
}

const UNDONE_BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'undo me' }]
}

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rewind-provenance-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function leftByDeadGeneration(): Promise<AgentSessionJournal> {
  const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
  const scope = { fence: DEAD, ownerFence: DEAD, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(TURN, { kind: 'turn', turnId: 'turn-dead', state: 'running' }, scope)
  const inTurn = {
    ...scope,
    turnScope: { kind: 'turn' as const, turnItemId: agentJournalItemKey(TURN) }
  }
  await journal.appendItem(
    PROMPT,
    {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: PENDING
    },
    inTurn
  )
  await journal.appendItem(REPLY, REPLY_BODY, inTurn)
  await journal.appendItem(UNDONE, UNDONE_BODY, { ...scope, fence: LIVE, ownerFence: LIVE })
  return journal
}

async function rewindAtLiveFence(journal: AgentSessionJournal): Promise<void> {
  const cut = structuredRewindCut(journal, {
    itemId: agentJournalItemKey(UNDONE),
    provider: 'codex',
    nativeId: 'thread-1'
  })
  await journal.replaceEpochItems('handle_forked', LIVE, cut!.kept)
}

describe('a rewind after a failed cleanup', () => {
  it("does not promote the dead generation's turn, prompt or reply to the live one", async () => {
    const journal = await leftByDeadGeneration()
    const before = journal.epoch

    await rewindAtLiveFence(journal)

    expect(journal.epoch).not.toBe(before)
    const work = new StructuredAgentSessionCurrentWork(journal, LIVE)
    // New row fence must not promote old execution provenance.
    expect(journal.itemFence(agentJournalItemKey(TURN))).toBe(DEAD)
    expect(journal.itemFence(agentJournalItemKey(PROMPT))).toBe(DEAD)
    expect(journal.itemFence(agentJournalItemKey(REPLY))).toBe(DEAD)
    expect(work.activeTurnId()).toBeNull()
    expect(work.actionablePromptIds()).toEqual([])
    expect(work.working()).toBe(false)
    expect(journal.itemBody(agentJournalItemKey(UNDONE))).toBeNull()
  })
})
