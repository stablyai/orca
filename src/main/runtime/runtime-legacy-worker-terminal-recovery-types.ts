import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { LegacyWorkerTerminalRecoveryPlan } from './orchestration/orchestration-legacy-worker-terminal-recovery'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

export type LegacyWorkerTerminalRecoveryResult = {
  blockedPaneCount: number
  adoptedDispatchIds: string[]
  exitedDispatchIds: string[]
  deferredDispatchIds: string[]
}

export type LegacyWorkerRecoveryOptions = {
  connectionId?: string
  materializeRenderer?: boolean
}

export type LegacyWorkerRecoveryCandidate = LegacyWorkerTerminalRecoveryPlan['candidates'][number]

export type LegacyWorkerRecoveryResolution = {
  candidate: LegacyWorkerRecoveryCandidate
  resolution: 'adopted' | 'exited'
}

export type TerminalWorkspaceLaunchScope = {
  id: string
  path: string
  connectionId: string | null
  repo: Repo | null
  folderWorkspace: FolderWorkspace | null
}

export type LegacyWorkerRecoveryWorkspace = {
  scope: TerminalWorkspaceLaunchScope
  resolved: ResolvedWorktree
}

export type LegacyWorkerRecoveryInventory = PtyControllerInventory

export type LegacyWorkerRecoveryPorts = {
  preparePlan: () => LegacyWorkerTerminalRecoveryPlan
  resolveWorkspace: (
    candidate: LegacyWorkerRecoveryCandidate
  ) => Promise<LegacyWorkerRecoveryWorkspace>
  refreshInventory: (
    worktrees: ResolvedWorktree[],
    connectionId: string | null
  ) => Promise<LegacyWorkerRecoveryInventory | null>
  /** Serializes the pre-adoption liveness probe and the adoption itself against other terminal mutations. */
  runMutation: <T>(worktreeId: string, operation: () => Promise<T>) => Promise<T>
  getActivation: (worktreeId: string) => { activeTabId?: string; activeGroupId?: string }
  hasExactPersistedSurface: (candidate: LegacyWorkerRecoveryCandidate) => boolean
  hasExactSurface: (candidate: LegacyWorkerRecoveryCandidate) => boolean
  adopt: (
    candidate: LegacyWorkerRecoveryCandidate,
    workspace: TerminalWorkspaceLaunchScope,
    inventory: LegacyWorkerRecoveryInventory,
    activation: { activeTabId?: string; activeGroupId?: string }
  ) => Promise<void>
  getRendererEpoch: () => number
  reveal: (candidate: LegacyWorkerRecoveryCandidate) => Promise<boolean | null>
  onPtyExit: (candidate: LegacyWorkerRecoveryCandidate) => void
  persist: (resolutions: readonly LegacyWorkerRecoveryResolution[]) => Promise<ReadonlySet<string>>
  rollback: (candidate: LegacyWorkerRecoveryCandidate) => void
  reconcileMissing: (candidate: LegacyWorkerRecoveryCandidate) => boolean
  notifyResolution: (
    candidate: LegacyWorkerRecoveryCandidate,
    resolution: 'adopted' | 'exited'
  ) => void
  canRecoverPersistentLocalPtys: () => boolean
  reconcileRequestedReleases: () => Promise<unknown>
  reconcile: (options: LegacyWorkerRecoveryOptions) => Promise<LegacyWorkerTerminalRecoveryResult>
  updateRetry: (
    plan: LegacyWorkerTerminalRecoveryPlan,
    deferredDispatchIds: ReadonlySet<string>,
    options: LegacyWorkerRecoveryOptions
  ) => void
}
