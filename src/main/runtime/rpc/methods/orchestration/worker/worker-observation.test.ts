import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { exposeDispatchContext, exposeWorker, inspectWorkerTerminal } from './worker-observation'
import type { DispatchContextRow, WorkerDispatchRow } from '../../../../orchestration/types'

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
  it('keeps a connected local worker live', async () => {
    const { runtime, db } = createHarness({
      connected: true,
      hostScope: { kind: 'local', hostId: 'local' }
    })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: true,
      status: 'live'
    })
  })

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
  it('parses the JSON columns once and emits one casing', () => {
    const exposed = exposeWorker({
      dispatch_id: DISPATCH_ID,
      runtime_epoch: 'epoch-1',
      state: 'ready',
      stage: 'input_accepted',
      worktree_id: 'repo::/tmp/wt',
      agent_terminal_handle: TERMINAL_HANDLE,
      setup_state: 'ran',
      effects: '[{"kind":"setup"}]',
      residual_resources: '["res-1"]',
      start_options: '{"agent":"codex"}',
      last_error: null,
      created_at: 'now',
      updated_at: 'now'
    } as WorkerDispatchRow)

    expect(exposed).toEqual({
      dispatchId: DISPATCH_ID,
      runtimeEpoch: 'epoch-1',
      state: 'ready',
      stage: 'input_accepted',
      worktreeId: 'repo::/tmp/wt',
      agentTerminalHandle: TERMINAL_HANDLE,
      setupState: 'ran',
      effects: [{ kind: 'setup' }],
      residualResources: ['res-1'],
      startOptions: { agent: 'codex' },
      lastError: null,
      createdAt: 'now',
      updatedAt: 'now'
    })
  })

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
    // The row shipped raw beside a camelCase `worker`; only the one spelling an older
    // paired CLI still prints may survive.
    expect(Object.keys(exposed).filter((key) => key.includes('_'))).toEqual(['task_id'])
  })

  // A paired CLI and host update independently, so an older CLI reads this receipt.
  // These are the fields it prints: src/cli/handlers/orchestration/
  // worker-observation-handlers.ts:18-19,25.
  it('keeps every field an older paired CLI prints', () => {
    const dispatch = exposeDispatchContext({
      id: DISPATCH_ID,
      run_id: 'run-1',
      task_id: 'task-1',
      status: 'dispatched'
    } as DispatchContextRow)

    expect(dispatch).toMatchObject({ id: DISPATCH_ID, task_id: 'task-1', status: 'dispatched' })
    expect(
      exposeWorker({
        state: 'ready',
        stage: 'input_accepted',
        effects: '[]',
        residual_resources: '[]',
        start_options: '{}'
      } as WorkerDispatchRow)
    ).toMatchObject({ state: 'ready', stage: 'input_accepted' })
  })
})
