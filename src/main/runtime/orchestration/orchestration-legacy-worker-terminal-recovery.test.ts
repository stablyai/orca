import { describe, expect, it } from 'vitest'
import type { LegacyWorkerTerminalRecoveryRow } from './types'
import { planLegacyWorkerTerminalRecovery } from './orchestration-legacy-worker-terminal-recovery'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const INCARNATION_ID = '22222222-2222-4222-8222-222222222222'

function recoveryRow(
  overrides: Partial<LegacyWorkerTerminalRecoveryRow> = {}
): LegacyWorkerTerminalRecoveryRow {
  return {
    dispatch_id: 'dispatch-1',
    task_id: 'task-1',
    dispatch_status: 'completed',
    contract_version: 0,
    assignee_handle: 'term-worker',
    assignee_pane_key: `tab-worker:${LEAF_ID}`,
    process_incarnation: `ssh:ssh-1@@pty-worker:${INCARNATION_ID}`,
    worker_state: 'ready',
    worktree_id: 'repo::/workspace',
    agent_terminal_handle: 'term-worker',
    ...overrides
  }
}

describe('legacy worker terminal recovery planning', () => {
  it('retains completed Dispatches when the worker process row is still live', () => {
    expect(planLegacyWorkerTerminalRecovery([recoveryRow()])).toEqual({
      blockedPanes: [
        {
          worktreeId: 'repo::/workspace',
          paneKey: `tab-worker:${LEAF_ID}`,
          contractVersion: 0,
          settled: false
        }
      ],
      candidates: [
        expect.objectContaining({
          dispatchId: 'dispatch-1',
          ptyId: 'ssh:ssh-1@@pty-worker',
          incarnationId: INCARNATION_ID
        })
      ],
      ambiguousDispatchIds: []
    })
  })

  it('blocks resume but refuses recovery when durable handles disagree', () => {
    expect(
      planLegacyWorkerTerminalRecovery([recoveryRow({ agent_terminal_handle: 'term-replacement' })])
    ).toEqual({
      blockedPanes: [
        {
          worktreeId: 'repo::/workspace',
          paneKey: `tab-worker:${LEAF_ID}`,
          contractVersion: 0,
          settled: false
        }
      ],
      candidates: [],
      ambiguousDispatchIds: []
    })
  })

  it('fences a settled worker pane without offering its terminal for adoption', () => {
    const plan = planLegacyWorkerTerminalRecovery([
      recoveryRow({ worker_state: 'succeeded', dispatch_status: 'completed' })
    ])
    expect(plan).toEqual({
      blockedPanes: [
        {
          worktreeId: 'repo::/workspace',
          paneKey: `tab-worker:${LEAF_ID}`,
          contractVersion: 0,
          settled: true
        }
      ],
      candidates: [],
      ambiguousDispatchIds: []
    })
  })

  it('does not let a settled row make a live worker identity ambiguous', () => {
    const plan = planLegacyWorkerTerminalRecovery([
      recoveryRow({ dispatch_id: 'dispatch-settled', worker_state: 'succeeded' }),
      recoveryRow({ dispatch_id: 'dispatch-live' })
    ])
    expect(plan.candidates).toEqual([expect.objectContaining({ dispatchId: 'dispatch-live' })])
    expect(plan.ambiguousDispatchIds).toEqual([])
    expect(plan.blockedPanes).toEqual([expect.objectContaining({ settled: false })])
  })

  it('fails closed when two Dispatches claim one terminal identity', () => {
    const plan = planLegacyWorkerTerminalRecovery([
      recoveryRow(),
      recoveryRow({ dispatch_id: 'dispatch-2', task_id: 'task-2' })
    ])

    expect(plan.candidates).toEqual([])
    expect(plan.ambiguousDispatchIds).toEqual(['dispatch-1', 'dispatch-2'])
    expect(plan.blockedPanes).toHaveLength(1)
  })

  it('does not trust malformed pane or process identities', () => {
    const plan = planLegacyWorkerTerminalRecovery([
      recoveryRow({
        assignee_pane_key: 'tab-worker:1',
        process_incarnation: 'runtime:pty:generation'
      })
    ])

    expect(plan).toEqual({
      blockedPanes: [],
      candidates: [],
      ambiguousDispatchIds: []
    })
  })
})
