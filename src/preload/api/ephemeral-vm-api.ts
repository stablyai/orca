import type { OrcaCloudAvailability, OrcaHooks } from '../../shared/orca-yaml-hook-types'
import type {
  HostedSessionIdleSleepEvent,
  HostedSessionRestartResult,
  HostedSessionStateEvent,
  HostedSessionWarningEvent
} from '../../shared/hosted-sandbox/hosted-session-events'
import type { PublicKnownRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { EphemeralVmRecipeDoctorResult } from '../../shared/ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from '../../shared/ephemeral-vm-recipe-diagnostics'
import type {
  EphemeralVmProvisionedRuntimeRecord,
  EphemeralVmRuntimeRecord,
  EphemeralVmWorkspaceLifecycleResult
} from '../../shared/ephemeral-vm-runtimes'
import type { EphemeralVmFailure } from '../../shared/ephemeral-vm-failure-copy'
import type {
  CloudSshCopyResult,
  CloudSshOpenEditorRequest,
  CloudSshOpenEditorResult,
  CloudSshRevokeResult,
  CloudSshStatus
} from '../../shared/cloud-ssh'
import type { CloudRemoteDesktopResult } from '../../shared/hosted-sandbox/cloud-remote-desktop'
import type { PendingVmCheckout } from '../../shared/pending-vm-checkouts'

export type EphemeralVmApi = {
  listRecipes: (args: { repoId: string }) => Promise<{
    status: 'ok' | 'error'
    repoPath: string | null
    recipes: OrcaHooks['environmentRecipes']
    diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
    message?: string
    messageCode?: string
    messageParams?: Record<string, string | number>
    /** Absent from older mains and web clients; treat as unavailable. */
    orcaCloud?: OrcaCloudAvailability
  }>
  listRecipeCatalog: () => Promise<
    {
      repoId: string
      repoName: string
      repoPath: string
      recipes: NonNullable<OrcaHooks['environmentRecipes']>
      diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
    }[]
  >
  doctor: (args: { repoId: string; recipeId: string }) => Promise<EphemeralVmRecipeDoctorResult>
  provision: (args: {
    repoId: string
    recipeId: string
    workspaceName?: string
    projectId?: string
    workspaceId?: string
    branch?: string
    ref?: string
    provisionId?: string
  }) => Promise<
    | {
        ok: true
        connectionType: 'orca-server'
        runtime: EphemeralVmProvisionedRuntimeRecord
        environment: PublicKnownRuntimeEnvironment
        stderr: string
        warnings: EphemeralVmRecipeResultWarning[]
      }
    | {
        ok: true
        connectionType: 'ssh'
        runtime: EphemeralVmProvisionedRuntimeRecord
        sshTargetId: string
        /** The managed Orca server the host runs; its workspace lives there. */
        environmentId?: string
        expectedRefHead?: string
        stderr: string
        warnings: EphemeralVmRecipeResultWarning[]
      }
    | ({ ok: false; stderr: string; stdout: string } & EphemeralVmFailure)
  >
  cancelProvision: (args: { provisionId: string }) => Promise<{ cancelled: boolean }>
  onProvisionEvent: (
    callback: (event: { provisionId: string; stream: 'stdout' | 'stderr'; chunk: string }) => void
  ) => () => void
  /** Orca Cloud: the session nears its cap (60/15/5 min left); running agents resume after the restart. */
  onCloudSessionWarning: (callback: (event: HostedSessionWarningEvent) => void) => () => void
  /** Orca Cloud: the workspace has been idle long enough to sleep through the ordinary Sleep flow. */
  onCloudIdleSleepRequested: (callback: (event: HostedSessionIdleSleepEvent) => void) => () => void
  /** Orca Cloud: a session rollover is restarting the workspace's machine, or it is back. */
  onCloudSessionState: (callback: (event: HostedSessionStateEvent) => void) => () => void
  /** Orca Cloud: roll the workspace's session over now instead of at the cap. */
  restartCloudSession: (args: { workspaceId: string }) => Promise<HostedSessionRestartResult>
  listRuntimes: () => Promise<EphemeralVmRuntimeRecord[]>
  /** Orca Cloud: runtime environment ids that are Orca Cloud VMs. Absent in the web client. */
  cloudEnvironmentIds?: () => Promise<string[]>
  /** Orca Cloud: starts the VM's desktop and forwards it to this computer's localhost. */
  openCloudRemoteDesktop?: (args: { environmentId: string }) => Promise<CloudRemoteDesktopResult>
  attachWorkspace: (args: {
    runtimeId: string
    workspaceId: string
  }) => Promise<EphemeralVmRuntimeRecord>
  resumeWorkspace: (args: { workspaceId: string }) => Promise<EphemeralVmWorkspaceLifecycleResult>
  /** Suspends the workspace's VM without closing panels; sleep closes them first. */
  suspendWorkspace: (args: { workspaceId: string }) => Promise<EphemeralVmWorkspaceLifecycleResult>
  /** Fires after any runtime record write; re-list to read the new lifecycle status. */
  onRuntimesChanged: (callback: () => void) => () => void
  cleanup: (args: { runtimeId: string }) => Promise<EphemeralVmRuntimeRecord>
  stopCleanup: (args: { runtimeId: string }) => Promise<EphemeralVmRuntimeRecord>
  /** Drops an interrupted write-ahead record that never received a recipe result. */
  forgetRuntime: (args: { runtimeId: string }) => Promise<void>
  getCleanupCommand: (args: { runtimeId: string }) => Promise<{
    runtimeId: string
    command: string | null
    payloadJson: string
    cleanupDisabled: boolean
    message?: string
  }>
  /** Orca Cloud SSH: whether it applies to a workspace, and which editors can open it. */
  cloudSshStatus: (args: { workspaceId: string }) => Promise<CloudSshStatus>
  /** Ensures access (waking only for the first key install) and copies the ssh command. */
  cloudSshCopyCommand: (args: { workspaceId: string }) => Promise<CloudSshCopyResult>
  cloudSshOpenInEditor: (args: CloudSshOpenEditorRequest) => Promise<CloudSshOpenEditorResult>
  cloudSshRevoke: (args: { workspaceId: string }) => Promise<CloudSshRevokeResult>
  /** Takes Orca's Include line back out of ~/.ssh/config. */
  cloudSshRemoveSshConfigInclude: () => Promise<boolean>
  /** This window's VM checkouts whose creates have not adopted them yet; replaces its last set. */
  publishPendingCheckouts: (checkouts: PendingVmCheckout[]) => void
  listPendingCheckouts: () => Promise<PendingVmCheckout[]>
  /** Every window's pending VM checkouts, whenever any window's set changes. */
  onPendingCheckoutsChanged: (callback: (checkouts: PendingVmCheckout[]) => void) => () => void
}
