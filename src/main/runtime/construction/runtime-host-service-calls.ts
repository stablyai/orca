import type { LegacyWorkerTerminalSurface } from '../orchestration/terminal-authority/legacy-worker-terminal-surface'
import type { OrcaRuntimeWithMarkPtyLivenessUnverifiable as MarkPtyLivenessUnverifiable } from '../terminal/layout/terminal-input-floor'
import type { OrcaRuntimeWithStopTerminalsForWorktree as StopTerminalsForWorktree } from '../terminal/stop/worktree-terminal-stop'
import type { OrcaRuntimeWithStopTerminalsForProject as StopTerminalsForProject } from '../terminal/stop/project-terminal-stop'
import type { RuntimeFederationOperations } from '../orchestration/federation/runtime-federation-operations'
import type { OrcaRuntimeWithHasExactPersistedTerminalSurfaceIdentity as HasExactPersistedTerminalSurfaceIdentity } from '../workspaces/persisted-surfaces/has-exact-persisted-terminal-surface-identity'
import type { LegacyWorkerRuntimeRecovery } from '../orchestration/terminal-authority/legacy-worker-runtime-recovery'
import type { OrcaRuntimeWithOnPtyExit as OnPtyExit } from '../terminal/lifecycle/pty-exit-lifecycle'
import type { OrcaRuntimeWithResolveWorktreeRemovalTarget as ResolveWorktreeRemovalTarget } from '../workspaces/workspace-removal-target'
import type { OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs as ReconcileHeadlessMobileSessionBrowserTabs } from '../session-lifecycle/projection/reconcile-headless-mobile-session-browser-tabs'
import type { OrcaRuntimeWithResolveBrowserNetworkExecutionHostForWorktree as ResolveBrowserNetworkExecutionHostForWorktree } from '../terminal/launch/terminal-workspace-scope'

export type GetPtyLivenessVerdictArgs = Parameters<
  MarkPtyLivenessUnverifiable['getPtyLivenessVerdict']
>
export type GetPtyLivenessVerdictResult = ReturnType<
  MarkPtyLivenessUnverifiable['getPtyLivenessVerdict']
>
export type StopTerminalsForWorktreeArgs = Parameters<
  StopTerminalsForWorktree['stopTerminalsForWorktree']
>
export type StopTerminalsForWorktreeResult = ReturnType<
  StopTerminalsForWorktree['stopTerminalsForWorktree']
>
export type StopTerminalsForProjectArgs = Parameters<
  StopTerminalsForProject['stopTerminalsForProject']
>
export type StopTerminalsForProjectResult = ReturnType<
  StopTerminalsForProject['stopTerminalsForProject']
>
export type ResolveOrchestrationWorkerServerArgs = Parameters<
  RuntimeFederationOperations['resolveOrchestrationWorkerServer']
>
export type ResolveOrchestrationWorkerServerResult = ReturnType<
  RuntimeFederationOperations['resolveOrchestrationWorkerServer']
>
export type CallOrchestrationWorkerServerArgs = Parameters<
  RuntimeFederationOperations['callOrchestrationWorkerServer']
>
export type CallOrchestrationWorkerServerResult = ReturnType<
  RuntimeFederationOperations['callOrchestrationWorkerServer']
>
export type SyncOrchestrationFederatedDispatchArgs = Parameters<
  RuntimeFederationOperations['syncOrchestrationFederatedDispatch']
>
export type SyncOrchestrationFederatedDispatchResult = ReturnType<
  RuntimeFederationOperations['syncOrchestrationFederatedDispatch']
>
export type GetLegacyWorkerRecoveryActivationArgs = Parameters<
  LegacyWorkerTerminalSurface['getLegacyWorkerRecoveryActivation']
>
export type GetLegacyWorkerRecoveryActivationResult = ReturnType<
  LegacyWorkerTerminalSurface['getLegacyWorkerRecoveryActivation']
>
export type HasExactPersistedTerminalSurfaceIdentityArgs = Parameters<
  HasExactPersistedTerminalSurfaceIdentity['hasExactPersistedTerminalSurfaceIdentity']
>
export type HasExactPersistedTerminalSurfaceIdentityResult = ReturnType<
  HasExactPersistedTerminalSurfaceIdentity['hasExactPersistedTerminalSurfaceIdentity']
>
export type HasExactTerminalSurfaceIdentityArgs = Parameters<
  HasExactPersistedTerminalSurfaceIdentity['hasExactTerminalSurfaceIdentity']
>
export type HasExactTerminalSurfaceIdentityResult = ReturnType<
  HasExactPersistedTerminalSurfaceIdentity['hasExactTerminalSurfaceIdentity']
>
export type AdoptLegacyWorkerTerminalArgs = Parameters<
  LegacyWorkerTerminalSurface['adoptLegacyWorkerTerminal']
>
export type AdoptLegacyWorkerTerminalResult = ReturnType<
  LegacyWorkerTerminalSurface['adoptLegacyWorkerTerminal']
>
export type OnPtyExitArgs = Parameters<OnPtyExit['onPtyExit']>
export type OnPtyExitResult = ReturnType<OnPtyExit['onPtyExit']>
export type ReconcileLegacyWorkerTerminalsArgs = Parameters<
  LegacyWorkerRuntimeRecovery['reconcileLegacyWorkerTerminals']
>
export type ReconcileLegacyWorkerTerminalsResult = ReturnType<
  LegacyWorkerRuntimeRecovery['reconcileLegacyWorkerTerminals']
>
export type UpdateLegacyWorkerTerminalRecoveryRetryArgs = Parameters<
  LegacyWorkerRuntimeRecovery['updateLegacyWorkerTerminalRecoveryRetry']
>
export type UpdateLegacyWorkerTerminalRecoveryRetryResult = ReturnType<
  LegacyWorkerRuntimeRecovery['updateLegacyWorkerTerminalRecoveryRetry']
>
export type RemoveWorktreeMetadataAndHistoryArgs = Parameters<
  ResolveWorktreeRemovalTarget['removeWorktreeMetadataAndHistory']
>
export type RemoveWorktreeMetadataAndHistoryResult = ReturnType<
  ResolveWorktreeRemovalTarget['removeWorktreeMetadataAndHistory']
>
export type WorkspaceSessionWorktreeHasRuntimeOwnedPtyCandidateArgs = Parameters<
  ReconcileHeadlessMobileSessionBrowserTabs['workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate']
>
export type WorkspaceSessionWorktreeHasRuntimeOwnedPtyCandidateResult = ReturnType<
  ReconcileHeadlessMobileSessionBrowserTabs['workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate']
>
export type ResolveTerminalWorkspaceLaunchScopeArgs = Parameters<
  ResolveBrowserNetworkExecutionHostForWorktree['resolveTerminalWorkspaceLaunchScope']
>
export type ResolveTerminalWorkspaceLaunchScopeResult = ReturnType<
  ResolveBrowserNetworkExecutionHostForWorktree['resolveTerminalWorkspaceLaunchScope']
>
