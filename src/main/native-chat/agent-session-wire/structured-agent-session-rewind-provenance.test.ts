// A rewind after a failed cleanup: the dead generation's turn and prompt are still saved as
// running and pending, and the rewind rebuilds the epoch at the live fence. Through the rewind's
// own row builders and a real SQLite journal, each carries the old fold's provenance, so the host
// projection never promotes that work to the live generation's.

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
import {
  mergeRetainedHostLifecycleRows,
  retainedRowReplacement,
  rewindProviderRows
} from './structured-rewind-retained-host-rows'

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
const LATER = codexItem('turn-live', 0)
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

const LATER_BODY: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'mine' }]
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

/** The dead generation's work as its cleanup left it: nothing settled. */
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
  return journal
}

/** The rewind's rebuild, as `rewindStructuredAgentSession` and its recovery write it. */
async function rewindAtLiveFence(journal: AgentSessionJournal): Promise<void> {
  const retained = journal.snapshot().items.map(({ itemId, observedAt, turnScope }) => {
    const ownerFence = journal.itemFence(itemId)
    return {
      itemId,
      body: journal.itemBody(itemId)!,
      observedAt,
      ...(turnScope ? { turnScope } : {}),
      ...(ownerFence === undefined ? {} : { ownerFence })
    }
  })
  // The live agent's history names the dead turn's prompt and reply it still holds, and one of
  // its own.
  const provider = rewindProviderRows(
    [
      { identity: PROMPT, body: journal.itemBody(agentJournalItemKey(PROMPT))! },
      { identity: REPLY, body: REPLY_BODY },
      { identity: LATER, body: LATER_BODY }
    ],
    2_000,
    LIVE
  )
  const merged = mergeRetainedHostLifecycleRows(retained, provider)
  await journal.replaceEpochItems('handle_forked', LIVE, merged.map(retainedRowReplacement))
}

describe('a rewind after a failed cleanup', () => {
  it("does not promote the dead generation's turn, prompt or reply to the live one", async () => {
    const journal = await leftByDeadGeneration()
    const before = journal.epoch

    await rewindAtLiveFence(journal)

    expect(journal.epoch).not.toBe(before)
    const work = new StructuredAgentSessionCurrentWork(journal, LIVE)
    // Rebuilt at the live fence, still the dead generation's work.
    expect(journal.itemFence(agentJournalItemKey(TURN))).toBe(DEAD)
    expect(journal.itemFence(agentJournalItemKey(PROMPT))).toBe(DEAD)
    expect(journal.itemFence(agentJournalItemKey(REPLY))).toBe(DEAD)
    expect(work.activeTurnId()).toBeNull()
    expect(work.actionablePromptIds()).toEqual([])
    expect(work.working()).toBe(false)
    // What the live agent itself reported is its own.
    expect(work.isCurrentItem(agentJournalItemKey(LATER))).toBe(true)
  })

  it('leaves a generation that is still live holding its own work', async () => {
    const journal = await leftByDeadGeneration()

    await rewindAtLiveFence(journal)

    const work = new StructuredAgentSessionCurrentWork(journal, DEAD)
    expect(work.activeTurnId()).toBe('turn-dead')
    expect(work.actionablePromptIds()).toEqual([agentJournalItemKey(PROMPT)])
  })
})
