import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { inspectWorkerTerminal, projectFleetWorker } from './worker-observation'

import { exposeDispatchContext } from './dispatch-context-exposure'
import type { DispatchContextRow } from '../../../../orchestration/types'

const DISPATCH_ID = 'ctx-worker'
const TERMINAL_HANDLE = 'term-worker'

function createHarness(args: {
  connected: boolean
  hostScope: { kind: 'local'; hostId: 'local' } | { kind: 'ssh'; targetId: string }
}) {
  const runtime = {
    showTerminal: vi.fn(async () => ({ handle: TERMINAL_HANDLE, connected: args.connected })),
    getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
    getTerminalLivenessVerdict: vi.fn(() => null),
    getOrchestrationDispatchAuthority: vi.fn(() => null)
  } as unknown as OrcaRuntimeService
  const db = {
    getWorkerDispatch: vi.fn(() => ({ agent_terminal_handle: TERMINAL_HANDLE })),
    getDispatchContextById: vi.fn(() => ({ host_scope: JSON.stringify(args.hostScope) })),
    isDispatchProcessCurrent: vi.fn(() => true)
  } as unknown as OrchestrationDb
  return { runtime, db }
}

describe('inspectWorkerTerminal missing liveness verdict', () => {
  it('keeps a disconnected local worker exited', async () => {
    const { runtime, db } = createHarness({
      connected: false,
      hostScope: { kind: 'local', hostId: 'local' }
    })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: true,
      status: 'exited'
    })
  })

  it('keeps a remote worker without a verdict unverifiable', async () => {
    const { runtime, db } = createHarness({
      connected: false,
      hostScope: { kind: 'ssh', targetId: 'ssh-target' }
    })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: true,
      status: 'unverifiable',
      reason: 'missing_liveness_verdict'
    })
  })
})

describe('worker-show receipt shape', () => {
  it('parses host_scope and withholds authority hashes from the dispatch row', () => {
    const exposed = exposeDispatchContext({
      id: DISPATCH_ID,
      run_id: 'run-1',
      task_id: 'task-1',
      launch_token_hash: 'launch-secret',
      capability_hash: 'capability-secret',
      host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
    } as DispatchContextRow)

    expect(exposed).toMatchObject({
      id: DISPATCH_ID,
      runId: 'run-1',
      taskId: 'task-1',
      hostScope: { kind: 'local', hostId: 'local' }
    })
    expect(exposed).not.toHaveProperty('host_scope')
    expect(exposed).not.toHaveProperty('launch_token_hash')
    expect(exposed).not.toHaveProperty('capability_hash')
    // Retain only the legacy dispatch spelling older paired CLIs still print beside camelCase worker.
    expect(Object.keys(exposed).filter((key) => key.includes('_'))).toEqual(['task_id'])
  })

  it('projects stopped_without_worker_done attention and worker-read nextAction for an unsettled worker whose turn ended', () => {
    const now = Date.now()
    const runtime = {
      getOrchestrationFleetAgentStatusSnapshot: vi.fn(() => [
        {
          binding: {
            kind: 'worker' as const,
            dispatchId: DISPATCH_ID,
            terminalHandle: TERMINAL_HANDLE,
            paneKey: 'tab-1:leaf-1',
            processIncarnation: 'pty-1:inc-1'
          },
          clock: { kind: 'observed' as const, at: now - 500 },
          deliveredAt: now - 500,
          activity: {
            paneKey: 'tab-1:leaf-1',
            connectionId: null,
            state: 'done' as const,
            agentType: 'codex',
            model: 'gpt-test',
            worktreeId: 'wt-1',
            restoredUnconfirmed: false,
            providerSessionOnly: false,
            lastAssistantMessage: 'Need confirmation to proceed.'
          }
        }
      ])
    } as unknown as OrcaRuntimeService

    const db = {
      listWorkerTerminalResources: vi.fn(() => [
        {
          dispatchId: DISPATCH_ID,
          taskId: 'task-1',
          runId: 'run-1',
          parentTaskId: null,
          workerState: 'ready',
          dispatchStatus: 'dispatched',
          workerStage: 'prompt_delivered',
          agentTerminalHandle: TERMINAL_HANDLE,
          paneKey: 'tab-1:leaf-1',
          worktreeId: 'wt-1',
          terminalState: 'active',
          pendingInput: false,
          pendingApproval: false,
          terminationReason: null,
          resource: null,
          createdAt: '2026-11-01T00:00:00Z',
          databaseId: 1
        }
      ]),
      getWorkerAttentionFactsForDispatches: vi.fn(
        () =>
          new Map([
            [
              DISPATCH_ID,
              {
                outcome: 'in_progress' as const,
                pendingInput: false,
                pendingGuidance: false,
                pendingApproval: false,
                terminationReason: null,
                isRoot: true,
                workerState: 'ready',
                workerStage: 'prompt_delivered',
                dispatchStatus: 'dispatched'
              }
            ]
          ])
      )
    } as unknown as OrchestrationDb

    const projection = projectFleetWorker(runtime, db, DISPATCH_ID)
    expect(projection).not.toBeNull()
    expect(projection?.attention).toEqual({
      categories: ['stopped_without_worker_done'],
      requiresAction: true,
      lastAssistantMessage: 'Need confirmation to proceed.'
    })
    expect(projection?.lastAssistantMessage).toBe('Need confirmation to proceed.')
    expect(projection?.nextAction).toEqual({
      kind: 'read',
      argv: ['orchestration', 'worker-read', '--dispatch', DISPATCH_ID]
    })
  })
})
