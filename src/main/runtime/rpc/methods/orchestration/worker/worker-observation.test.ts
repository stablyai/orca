import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { inspectWorkerTerminal } from './worker-observation'

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
})
