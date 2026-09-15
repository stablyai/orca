import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  exposeDispatchContext,
  exposeObservation,
  exposeWorker,
  inspectWorkerTerminal
} from './worker-observation'
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

  // O1: worker-observation.ts minted `exited` from a disconnected PTY plus an absent liveness
  // verdict — that is contact loss, not a host vouching for the process's death. Was pinned
  // 'exited'; loss of contact is never exited (AGENTS.md rule 7).
  it('reports a disconnected local worker with no liveness verdict as unverifiable', async () => {
    const { runtime, db } = createHarness({
      connected: false,
      hostScope: { kind: 'local', hostId: 'local' }
    })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: true,
      status: 'unverifiable'
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

describe('inspectWorkerTerminal showTerminal failure classification', () => {
  function createFailureHarness(showTerminal: () => Promise<never>) {
    const runtime = {
      showTerminal,
      getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
      getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
      getTerminalLivenessVerdict: vi.fn(() => null),
      getOrchestrationDispatchAuthority: vi.fn(() => null)
    } as unknown as OrcaRuntimeService
    const db = {
      getWorkerDispatch: vi.fn(() => ({ agent_terminal_handle: TERMINAL_HANDLE })),
      getDispatchContextById: vi.fn(() => ({
        host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })),
      isDispatchProcessCurrent: vi.fn(() => true)
    } as unknown as OrchestrationDb
    return { runtime, db }
  }

  // O1: every showTerminal exception collapsed to 'missing' — a transport timeout got the same
  // owner-proven-absence verdict as the owner actually saying "not found".
  it('classifies an unclassified showTerminal failure as unverifiable, not missing', async () => {
    const { runtime, db } = createFailureHarness(() =>
      Promise.reject(new Error('boom, nothing recognizable'))
    )

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: false,
      status: 'unverifiable'
    })
  })

  it('classifies a request timeout as unverifiable, not missing', async () => {
    const { runtime, db } = createFailureHarness(() =>
      Promise.reject(Object.assign(new Error('deadline exceeded'), { code: 'request_timeout' }))
    )

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: false,
      status: 'unverifiable'
    })
  })

  it('keeps missing when the owner proves the terminal is gone', async () => {
    const { runtime, db } = createFailureHarness(() =>
      Promise.reject(Object.assign(new Error('terminal_gone'), { code: 'terminal_gone' }))
    )

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: false,
      status: 'missing'
    })
  })

  // O2: terminal_handle_stale and terminal_not_found describe a renderer graph-epoch mismatch or a
  // missing/mismatched local leaf (orca-runtime-build-pty-terminal-summary.ts) -- the client-side
  // handle graph, not the execution owner's process. Only a resolved null or a PTY-host
  // terminal_gone is owner-proven missing; these two must not mint missing.
  it('treats terminal_handle_stale as unverifiable, not owner-proven missing', async () => {
    const { runtime, db } = createFailureHarness(() =>
      Promise.reject(
        Object.assign(new Error('terminal_handle_stale'), { code: 'terminal_handle_stale' })
      )
    )

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: false,
      status: 'unverifiable'
    })
  })

  it('treats terminal_not_found as unverifiable, not owner-proven missing', async () => {
    const { runtime, db } = createFailureHarness(() =>
      Promise.reject(new Error('terminal_not_found'))
    )

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      exact: false,
      status: 'unverifiable'
    })
  })
})

describe('exposeObservation liveness verdict', () => {
  // O1 deviation: a narrowing to `live | unverifiable | exited` was tried here and reverted —
  // workers-recovery.test.ts pins `identity_changed` and `unattached` as their own exposed wire
  // values, each with distinct operator/CLI meaning a plain `exited` would have erased. This just
  // pins the passthrough those tests already rely on.
  it('passes every status straight through, with its own reason', () => {
    expect(exposeObservation({ terminal: null, exact: false, status: 'unattached' })).toEqual({
      status: 'unattached',
      exactWorker: false
    })
    expect(exposeObservation({ terminal: null, exact: false, status: 'missing' })).toEqual({
      status: 'missing',
      exactWorker: false
    })
    expect(exposeObservation({ terminal: null, exact: false, status: 'identity_changed' })).toEqual(
      { status: 'identity_changed', exactWorker: false }
    )
    expect(exposeObservation({ terminal: null, exact: true, status: 'live' })).toEqual({
      status: 'live',
      exactWorker: true
    })
    expect(
      exposeObservation({
        terminal: null,
        exact: true,
        status: 'unverifiable',
        reason: 'timeout'
      })
    ).toEqual({ status: 'unverifiable', exactWorker: true, reason: 'timeout' })
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
