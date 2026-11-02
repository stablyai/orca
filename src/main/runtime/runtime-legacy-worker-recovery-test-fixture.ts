import { vi, type Mock } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { OrchestrationError } from './orchestration/orchestration-error'
import { RuntimeLegacyWorkerTerminalRecoveryController } from './runtime-legacy-worker-terminal-recovery-controller'
import type {
  LegacyWorkerRecoveryCandidate,
  LegacyWorkerRecoveryInventory,
  LegacyWorkerRecoveryOptions,
  LegacyWorkerRecoveryPorts,
  LegacyWorkerRecoveryResolution
} from './runtime-legacy-worker-terminal-recovery-types'

export function missingWorkspaceWorker(
  overrides: Partial<LegacyWorkerRecoveryCandidate> = {}
): LegacyWorkerRecoveryCandidate {
  return {
    dispatchId: 'dispatch-1',
    dispatchStatus: 'dispatched',
    contractVersion: 1,
    taskId: 'task-1',
    worktreeId: 'repo-1::/deleted/worktree',
    terminalHandle: 'handle-1',
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    tabId: 'tab-1',
    leafId: '11111111-1111-4111-8111-111111111111',
    processIncarnation: 'pty-1:22222222-2222-4222-8222-222222222222',
    ptyId: 'pty-1',
    incarnationId: '22222222-2222-4222-8222-222222222222',
    ...overrides
  }
}

export function missingWorkspaceRecoveryFixture(
  candidates = [missingWorkspaceWorker()],
  inventory: LegacyWorkerRecoveryInventory | null = null
): {
  controller: RuntimeLegacyWorkerTerminalRecoveryController
  ports: LegacyWorkerRecoveryPorts
  refreshInventory: Mock<LegacyWorkerRecoveryPorts['refreshInventory']>
  persist: Mock<LegacyWorkerRecoveryPorts['persist']>
  reconcileMissing: Mock<LegacyWorkerRecoveryPorts['reconcileMissing']>
  rollback: Mock<LegacyWorkerRecoveryPorts['rollback']>
  adopt: Mock<LegacyWorkerRecoveryPorts['adopt']>
  reconcile: Mock<LegacyWorkerRecoveryPorts['reconcile']>
} {
  const refreshInventory = vi.fn(async () => inventory)
  const persist = vi.fn(
    async (resolutions: readonly LegacyWorkerRecoveryResolution[]) =>
      new Set(resolutions.map(({ candidate }) => candidate.dispatchId))
  )
  const reconcileMissing = vi.fn(() => true)
  const rollback = vi.fn()
  const adopt = vi.fn()
  const reconcile = vi.fn((options: LegacyWorkerRecoveryOptions) => controller.reconcile(options))
  const ports: LegacyWorkerRecoveryPorts = {
    preparePlan: () => ({ candidates, ambiguousDispatchIds: [] }),
    resolveWorkspace: async () => {
      throw new OrchestrationError('selector_not_found', 'Workspace was deleted')
    },
    refreshInventory,
    runMutation: async (_worktreeId, operation) => operation(),
    getActivation: () => ({}),
    hasExactPersistedSurface: () => false,
    hasExactSurface: () => false,
    adopt,
    getRendererEpoch: () => 0,
    reveal: async () => null,
    onPtyExit: vi.fn(),
    persist,
    rollback,
    reconcileMissing,
    notifyResolution: vi.fn(),
    canRecoverPersistentLocalPtys: () => true,
    hasRequestedReleases: () => false,
    reconcileRequestedReleases: async () => undefined,
    reconcile,
    updateRetry: (plan, deferred, options) => controller.updateRetry(plan, deferred, options)
  }
  const controller = new RuntimeLegacyWorkerTerminalRecoveryController(ports)
  return {
    controller,
    ports,
    refreshInventory,
    persist,
    reconcileMissing,
    rollback,
    adopt,
    reconcile
  }
}

export function emptyLocalWorkerInventory(): LegacyWorkerRecoveryInventory {
  return {
    livePtyIds: new Set(),
    allLivePtyIds: new Set(),
    terminalIdentityByPtyId: new Map(),
    queriedHostIds: new Set([LOCAL_EXECUTION_HOST_ID])
  }
}
