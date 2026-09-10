import { describe, expect, it, vi } from 'vitest'
import type { MaestroTerminalLease } from '../../../../shared/maestro-terminal-lease'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { observeMaestroTerminalLiveness } from './maestro-run-progress-terminal-liveness'

function lease(overrides: Partial<MaestroTerminalLease> = {}): MaestroTerminalLease {
  return {
    id: 'lease-1',
    requestId: 'request-1',
    executionHostId: 'local',
    workspaceKey: 'folder:workspace-1',
    terminalHandle: 'terminal-1',
    tabId: 'tab-1',
    paneKey: 'tab-1:leaf-1',
    ptyIncarnation: 'pty-1:incarnation-1',
    processRootId: 'pty-1',
    runId: 'run-1',
    taskId: null,
    attemptId: null,
    coordinatorGeneration: 1,
    role: 'coordinator',
    workerTerminalResourceId: null,
    coordinatorRunId: 'run-1',
    title: 'Coordinator',
    launchProfile: {
      agent: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      permissionMode: 'default',
      routeRef: null
    },
    parentLeaseId: null,
    spawnedBy: 'runtime',
    ownerPrincipal: 'coordinator:g1',
    retentionPolicy: 'retain',
    lifecycleState: 'retained',
    observation: null,
    providerSessionId: null,
    capsuleDigest: null,
    cleanupReceipt: null,
    archivedTail: null,
    createdAt: '2026-09-08T12:00:00.000Z',
    updatedAt: '2026-09-08T12:00:00.000Z',
    ...overrides
  }
}

function runtime() {
  return {
    showTerminal: vi.fn(async () => ({
      tabId: 'tab-1',
      worktreeId: 'folder:workspace-1',
      connected: true
    })),
    getTerminalPaneKey: vi.fn(() => 'tab-1:leaf-1'),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-1:incarnation-1'),
    getTerminalLivenessVerdict: vi.fn(() => null),
    getOrchestrationDispatchAuthority: vi.fn(() => null)
  } as unknown as OrcaRuntimeService
}

describe('Maestro Run terminal liveness observation', () => {
  it('reports a locally observed exact coordinator terminal as live', async () => {
    const exactRuntime = runtime()
    const result = await observeMaestroTerminalLiveness(exactRuntime, {} as OrchestrationDb, [
      lease()
    ])

    expect(result.get('lease-1')).toBe('live')
  })

  it('keeps a missing retained coordinator terminal unverifiable', async () => {
    const missingRuntime = runtime()
    vi.mocked(missingRuntime.showTerminal).mockRejectedValue(new Error('host unavailable'))
    const result = await observeMaestroTerminalLiveness(missingRuntime, {} as OrchestrationDb, [
      lease({ executionHostId: 'ssh:host-1' })
    ])

    expect(result.get('lease-1')).toBe('unverifiable')
  })

  it('keeps a disconnected local coordinator unverifiable without exit evidence', async () => {
    const disconnectedRuntime = runtime()
    vi.mocked(disconnectedRuntime.showTerminal).mockResolvedValue({
      tabId: 'tab-1',
      worktreeId: 'folder:workspace-1',
      connected: false
    } as never)
    const result = await observeMaestroTerminalLiveness(
      disconnectedRuntime,
      {} as OrchestrationDb,
      [lease()]
    )

    expect(result.get('lease-1')).toBe('unverifiable')
  })

  it('uses a cleanup receipt as positive exit evidence', async () => {
    const exactRuntime = runtime()
    const result = await observeMaestroTerminalLiveness(exactRuntime, {} as OrchestrationDb, [
      lease({
        lifecycleState: 'superseded',
        cleanupReceipt: {
          verdict: 'exited',
          processTreeVerified: true,
          closedTerminalHandle: 'terminal-1',
          replacementTerminalHandle: null,
          replacementIncarnation: null,
          archiveRef: null,
          observedAt: '2026-09-08T12:01:00.000Z'
        }
      })
    ])

    expect(result.get('lease-1')).toBe('exited')
    expect(exactRuntime.showTerminal).not.toHaveBeenCalled()
  })

  it('keeps a retained SSH worker without a host verdict unverifiable', async () => {
    const remoteRuntime = runtime()
    const db = {
      getWorkerDispatch: vi.fn(() => ({ agent_terminal_handle: 'terminal-1' })),
      getDispatchContextById: vi.fn(() => ({
        host_scope: JSON.stringify({ kind: 'ssh', targetId: 'host-1' })
      })),
      isDispatchProcessCurrent: vi.fn(() => true)
    } as unknown as OrchestrationDb
    const result = await observeMaestroTerminalLiveness(remoteRuntime, db, [
      lease({
        executionHostId: 'ssh:host-1',
        role: 'worker',
        coordinatorGeneration: null,
        coordinatorRunId: null,
        ownerPrincipal: 'dispatch:dispatch-1'
      })
    ])

    expect(result.get('lease-1')).toBe('unverifiable')
  })

  it('does not attribute a replacement terminal incarnation to an old worker lease', async () => {
    const replacementRuntime = runtime()
    vi.mocked(replacementRuntime.getTerminalProcessIncarnation).mockReturnValue(
      'pty-1:incarnation-2'
    )
    vi.mocked(replacementRuntime.getTerminalLivenessVerdict).mockReturnValue({
      status: 'live',
      ptyIds: ['pty-1']
    })
    const db = {
      getWorkerDispatch: vi.fn(() => ({ agent_terminal_handle: 'terminal-1' })),
      getDispatchContextById: vi.fn(() => ({
        host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
      })),
      isDispatchProcessCurrent: vi.fn(() => true)
    } as unknown as OrchestrationDb
    const result = await observeMaestroTerminalLiveness(replacementRuntime, db, [
      lease({
        role: 'worker',
        coordinatorGeneration: null,
        coordinatorRunId: null,
        ownerPrincipal: 'dispatch:dispatch-1'
      })
    ])

    expect(result.get('lease-1')).toBe('unverifiable')
  })
})
