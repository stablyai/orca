import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { mintFleetAgentStatusEvidence } from '../../../shared/orchestration-fleet-agent-status-evidence'
import type { WorkerAttentionFacts } from './db/worker-terminal/worker-terminal-attention-query'
import { projectWorkerAttentionContext } from './worker-attention-context'

const NOW = 10 * AGENT_STATUS_STALE_AFTER_MS

function facts(overrides: Partial<WorkerAttentionFacts> = {}): WorkerAttentionFacts {
  return {
    outcome: 'in_progress',
    pendingInput: false,
    pendingGuidance: false,
    pendingApproval: false,
    terminationReason: null,
    isRoot: false,
    workerState: 'ready',
    workerStage: 'prompt_delivered',
    dispatchStatus: 'dispatched',
    ...overrides
  }
}

function status(overrides: Partial<AgentStatusIpcPayload> = {}) {
  return mintFleetAgentStatusEvidence(
    {
      paneKey: 'tab-1:leaf-1',
      connectionId: null,
      state: 'working',
      receivedAt: NOW - 1,
      stateStartedAt: NOW - 1,
      ...overrides
    } as AgentStatusIpcPayload,
    {
      kind: 'pane',
      terminalHandle: 'term-1',
      paneKey: 'tab-1:leaf-1',
      processIncarnation: 'pty-1:inc-1'
    }
  )
}

describe('worker attention liveness', () => {
  it('decays on the evidence clock, not the replayed delivery clock', () => {
    const attention = projectWorkerAttentionContext({
      facts: facts(),
      isRoot: false,
      // A relay reconnect restamps receivedAt; the underlying evidence is an hour old.
      evidence: status({ evidenceObservedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000 }),
      now: NOW
    })

    expect(attention.categories).toContain('stale')
    expect(attention.requiresAction).toBe(false)
  })

  it('will not call a remote pane live without the connection that observed it', () => {
    const attention = projectWorkerAttentionContext({
      facts: facts({ hostScope: '{"kind":"ssh","targetId":"host-1"}' }),
      isRoot: false,
      evidence: status(),
      now: NOW
    })

    expect(attention.categories).toContain('unverifiable')
    expect(attention.requiresAction).toBe(true)
  })

  it('accepts a fresh local pane', () => {
    const attention = projectWorkerAttentionContext({
      facts: facts({ hostScope: '{"kind":"local","hostId":"local"}' }),
      isRoot: false,
      evidence: status(),
      now: NOW
    })

    expect(attention).toEqual({ categories: [], requiresAction: false })
  })

  it('reads a released resource as exited, not as a stale live pane', () => {
    const attention = projectWorkerAttentionContext({
      // worker-list called the same dispatch exited while this pane classified from a status.
      facts: facts({
        outcome: 'outcome_unknown',
        hostScope: '{"kind":"local","hostId":"local"}',
        releaseState: 'released'
      }),
      isRoot: false,
      evidence: status({ evidenceObservedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000 }),
      now: NOW
    })

    expect(attention).toEqual({ categories: [], requiresAction: false })
  })

  it('reads a released worker stage as exited, not as a stale live pane', () => {
    const attention = projectWorkerAttentionContext({
      facts: facts({
        outcome: 'outcome_unknown',
        workerStage: 'released',
        hostScope: '{"kind":"local","hostId":"local"}'
      }),
      isRoot: false,
      evidence: status({ evidenceObservedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 60_000 }),
      now: NOW
    })

    expect(attention).toEqual({ categories: [], requiresAction: false })
  })

  it('treats a settled worker stop as exited rather than unverifiable', () => {
    const attention = projectWorkerAttentionContext({
      facts: facts({ workerState: 'stopped', outcome: 'in_progress' }),
      isRoot: false,
      evidence: undefined,
      now: NOW
    })

    expect(attention).toEqual({ categories: [], requiresAction: false })
  })
})
