import type { OrcaRuntimeWithMarkPtyLivenessUnverifiable as MarkPtyLivenessUnverifiable } from '../terminal/layout/terminal-input-floor'
import type { OrcaRuntimeWithStopTerminalsForWorktree as StopTerminalsForWorktree } from '../terminal/stop/worktree-terminal-stop'
import type { OrcaRuntimeWithStopTerminalsForProject as StopTerminalsForProject } from '../terminal/stop/project-terminal-stop'
import type { OrcaRuntimeWithGetRuntimeId as GetRuntimeId } from '../workspaces/session-hosts/get-runtime-id'
import type { OrcaRuntimeWithHasExactPersistedTerminalSurfaceIdentity as HasExactPersistedTerminalSurfaceIdentity } from '../workspaces/persisted-surfaces/has-exact-persisted-terminal-surface-identity'
import type { OrcaRuntimeWithAutomationOperations as AutomationOperations } from '../workspaces/persisted-surfaces/automation-operations'
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
  GetRuntimeId['resolveOrchestrationWorkerServer']
>
export type ResolveOrchestrationWorkerServerResult = ReturnType<
  GetRuntimeId['resolveOrchestrationWorkerServer']
>
export type CallOrchestrationWorkerServerArgs = Parameters<
  GetRuntimeId['callOrchestrationWorkerServer']
>
export type CallOrchestrationWorkerServerResult = ReturnType<
  GetRuntimeId['callOrchestrationWorkerServer']
>
export type SyncOrchestrationFederatedDispatchArgs = Parameters<
  GetRuntimeId['syncOrchestrationFederatedDispatch']
>
export type SyncOrchestrationFederatedDispatchResult = ReturnType<
  GetRuntimeId['syncOrchestrationFederatedDispatch']
>
export type GetLegacyWorkerRecoveryActivationArgs = Parameters<
  HasExactPersistedTerminalSurfaceIdentity['getLegacyWorkerRecoveryActivation']
>
export type GetLegacyWorkerRecoveryActivationResult = ReturnType<
  HasExactPersistedTerminalSurfaceIdentity['getLegacyWorkerRecoveryActivation']
>
export type HasExactPersistedTerminalSurfaceIdentityArgs = Parameters<
  HasExactPersistedTerminalSurfaceIdentity['hasExactPersistedTerminalSurfaceIdentity']
>
export type HasExactPersistedTerminalSurfaceIdentityResult = ReturnType<
  HasExactPersistedTerminalSurfaceIdentity['hasExactPersistedTerminalSurfaceIdentity']
>
export type HasExactTerminalSurfaceIdentityArgs = Parameters<
  AutomationOperations['hasExactTerminalSurfaceIdentity']
>
export type HasExactTerminalSurfaceIdentityResult = ReturnType<
  AutomationOperations['hasExactTerminalSurfaceIdentity']
>
export type AdoptLegacyWorkerTerminalArgs = Parameters<
  HasExactPersistedTerminalSurfaceIdentity['adoptLegacyWorkerTerminal']
>
export type AdoptLegacyWorkerTerminalResult = ReturnType<
  HasExactPersistedTerminalSurfaceIdentity['adoptLegacyWorkerTerminal']
>
export type OnPtyExitArgs = Parameters<OnPtyExit['onPtyExit']>
export type OnPtyExitResult = ReturnType<OnPtyExit['onPtyExit']>
export type ReconcileLegacyWorkerTerminalsArgs = Parameters<
  AutomationOperations['reconcileLegacyWorkerTerminals']
>
export type ReconcileLegacyWorkerTerminalsResult = ReturnType<
  AutomationOperations['reconcileLegacyWorkerTerminals']
>
export type UpdateLegacyWorkerTerminalRecoveryRetryArgs = Parameters<
  AutomationOperations['updateLegacyWorkerTerminalRecoveryRetry']
>
export type UpdateLegacyWorkerTerminalRecoveryRetryResult = ReturnType<
  AutomationOperations['updateLegacyWorkerTerminalRecoveryRetry']
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
