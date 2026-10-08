import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentJournalToolCallLifecycle } from '../../../shared/agent-journal-tool-call-lifecycle'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionDeathEvidence } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  settleStaleStructuredAgentSessionState,
  settleStructuredAgentSessionDeadGeneration
} from './structured-agent-session-dead-generation-settlement'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'

const SESSION = 'session-late-proof'
const THREAD = 'thread-1'

/** A probe that found the given owner's child gone at 9000. */
function proofFor(ownerFence: number | undefined): AgentSessionDeathEvidence {
  return {
    kind: 'pid-absent',
    detail: 'recorded pid absent on host',
    observedAt: 9_000,
    ...(ownerFence === undefined ? {} : { ownerFence }),
    lastProvenAliveAt: 150
  }
}

function identityOf(turnId: string, ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: THREAD, turnId, ordinal }
}

let root: string
let journals: ReturnType<typeof createTrackedJournalOpener>
let journal: AgentSessionJournal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-late-proof-'))
  journals = createTrackedJournalOpener()
  journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: codexProviderHandle(THREAD)
    },
    stateDirectory: root,
    now: () => 100
  })
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A running turn its owner wrote, with a running call and the given finished calls in it. */
async function seedTurn(
  turnId: string,
  fence: number,
  finished: AgentJournalItemBody[] = []
): Promise<void> {
  const turn = identityOf(turnId, 0)
  await journal.appendItem(
    turn,
    { kind: 'turn', turnId, state: 'running', startedAt: 100 },
    { fence, turnScope: { kind: 'thread' } }
  )
  const calls: AgentJournalItemBody[] = [
    { kind: 'tool-call', name: 'shell', input: { command: 'sleep 20' }, state: 'running' },
    ...finished
  ]
  for (const [index, body] of calls.entries()) {
    await journal.appendItem(identityOf(turnId, index + 1), body, {
      fence,
      turnScope: { kind: 'turn', turnItemId: agentJournalItemKey(turn) }
    })
  }
}

function settle(fence: number, deathEvidence: AgentSessionDeathEvidence | null) {
  return settleStaleStructuredAgentSessionState({
    journal,
    sessionId: SESSION,
    fence,
    acquisitionGeneration: `generation-${fence}`,
    deathEvidence
  })
}

function turnState(turnId: string) {
  const item = journal
    .snapshot()
    .items.find((row) => readAgentJournalTurn(row.body)?.turnId === turnId)
  return readAgentJournalTurn(item?.body)?.state
}

function callLifecycle(turnId: string, ordinal: number) {
  const key = agentJournalItemKey(identityOf(turnId, ordinal))
  const body = journal.snapshot().items.find((item) => item.itemId === key)?.body
  return body?.kind === 'tool-call' ? agentJournalToolCallLifecycle(body) : undefined
}

describe('a proof written after an unverifiable settle', () => {
  it('corrects the call that settle closed along with its turn, and only once', async () => {
    await seedTurn('turn-1', 1, [
      // Failed on its own before the death: no proof of the death makes it interrupted.
      { kind: 'tool-call', name: 'shell', input: { command: 'false' }, state: 'failed' },
      { kind: 'tool-call', name: 'read', input: { path: 'a' }, state: 'completed' }
    ])

    await settle(2, null)
    expect(turnState('turn-1')).toBe('unverifiable')
    // Nothing proved the end, so the call reads failed, as it always has.
    expect(callLifecycle('turn-1', 1)).toBe('failed')

    await settle(3, proofFor(1))
    expect(turnState('turn-1')).toBe('interrupted')
    expect(callLifecycle('turn-1', 1)).toBe('interrupted')
    expect(callLifecycle('turn-1', 2)).toBe('failed')
    expect(callLifecycle('turn-1', 3)).toBe('completed')

    const corrected = journal.cursor()
    await expect(settle(4, proofFor(1))).resolves.toBe(0)
    expect(journal.cursor()).toEqual(corrected)
  })

  it("leaves a call alone when the proof names another owner's child", async () => {
    await seedTurn('turn-1', 1)
    await settle(2, null)
    await seedTurn('turn-2', 2)
    await settle(3, null)
    expect(callLifecycle('turn-2', 1)).toBe('failed')

    const unrevised = journal.cursor()
    // A later owner's death, and an older build's proof naming no owner, prove nothing about it.
    await expect(settle(4, proofFor(5))).resolves.toBe(0)
    await expect(settle(4, { ...proofFor(undefined), kind: 'exit-observed' })).resolves.toBe(0)
    expect(journal.cursor()).toEqual(unrevised)

    await settle(4, proofFor(1))
    expect(callLifecycle('turn-1', 1)).toBe('interrupted')
    expect(turnState('turn-2')).toBe('unverifiable')
    expect(callLifecycle('turn-2', 1)).toBe('failed')
  })

  it('corrects a call an unverifiable restart eviction closed', async () => {
    await seedTurn('turn-1', 7)
    await settleStructuredAgentSessionDeadGeneration({
      journal,
      sessionId: SESSION,
      fence: 8,
      settlementId: `restart-eviction:${SESSION}:8`,
      pendingSubmissionReason: 'provider_exited_before_acknowledgement',
      verdict: { state: 'unverifiable' },
      showUnexpectedExitOutcome: false
    })
    expect(callLifecycle('turn-1', 1)).toBe('failed')

    await settle(9, proofFor(7))
    expect(turnState('turn-1')).toBe('interrupted')
    expect(callLifecycle('turn-1', 1)).toBe('interrupted')
  })
})
