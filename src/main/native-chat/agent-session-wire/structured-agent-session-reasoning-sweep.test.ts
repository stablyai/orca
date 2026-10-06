// A reasoning row a dead generation left open is ended by both host sweeps, and is not by itself
// evidence that a response was interrupted.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import {
  captureUnfinishedStructuredAgentSessionWork,
  settleStaleStructuredAgentSessionState,
  settleStructuredAgentSessionDeadGeneration
} from './structured-agent-session-dead-generation-settlement'

const SESSION = 'session-reasoning-sweep'
const THREAD = 'thread-1'
const REASONING = { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 1 } as const
let root: string
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-reasoning-sweep-'))
  journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    },
    database: openTestJournalHostDatabase(root),
    now: () => 1_000
  })
})

afterEach(async () => {
  await journal.close()
  await rm(root, { recursive: true, force: true })
})

async function seedOpenReasoning(turnState: 'running' | 'completed'): Promise<void> {
  await journal.appendItem(
    REASONING,
    {
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Weighing options' }],
      state: 'running'
    },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 2 },
    { kind: 'turn', turnId: 'turn-1', state: turnState, startedAt: 900 },
    { fence: 7, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

function reasoningBody(): AgentJournalItemBody | undefined {
  return journal
    .snapshot()
    .items.find((item) => item.body.kind === 'message' && item.body.role === 'reasoning')?.body
}

describe('an open reasoning row a dead generation left', () => {
  it('ends, with no claimed time, when the generation is settled at its exit', async () => {
    await seedOpenReasoning('running')
    await expect(
      settleStructuredAgentSessionDeadGeneration({
        journal,
        sessionId: SESSION,
        fence: 8,
        settlementId: `expected-close:${SESSION}:8`,
        pendingSubmissionReason: 'provider_closed_before_acknowledgement',
        verdict: { state: 'interrupted', completedAt: 1_500 },
        showUnexpectedExitOutcome: false
      })
    ).resolves.toEqual({ ok: true })
    expect(reasoningBody()).toEqual({
      kind: 'message',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Weighing options' }],
      state: 'completed'
    })
  })

  it('ends when a later acquisition or reopen sweeps the stale generation', async () => {
    await seedOpenReasoning('running')
    await settleStaleStructuredAgentSessionState({
      journal,
      sessionId: SESSION,
      fence: 8,
      acquisitionGeneration: 'generation-8',
      deathEvidence: null
    })
    expect(reasoningBody()).toMatchObject({ state: 'completed' })
    expect(reasoningBody()).not.toHaveProperty('completedAt')
  })

  it('is not by itself unfinished work, so it adds no exit row to a settled turn', async () => {
    await seedOpenReasoning('completed')
    expect(captureUnfinishedStructuredAgentSessionWork(journal).items).toEqual([])
  })
})
