import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { EphemeralVmRecipeDoctorResult } from '../../../shared/ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from '../../../shared/ephemeral-vm-recipe-diagnostics'
import type {
  EphemeralVmProvisionedRuntimeRecord,
  EphemeralVmRuntimeRecord,
  EphemeralVmWorkspaceLifecycleResult
} from '../../../shared/ephemeral-vm-runtimes'
import type { EphemeralVmFailure } from '../../../shared/ephemeral-vm-failure-copy'
import type { PendingVmCheckout } from '../../../shared/pending-vm-checkouts'

export type EphemeralVmApi = {
  listRecipes: (args: { repoId: string }) => Promise<{
    status: 'ok' | 'error'
    repoPath: string | null
    recipes: OrcaHooks['environmentRecipes']
    diagnostics: NonNullable<OrcaHooks['environmentRecipeDiagnostics']>
    message?: string
    messageCode?: string
    messageParams?: Record<string, string | number>
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
  /** Credential-like variable names (never values) recipe scripts would inherit from Orca. */
  listCredentialEnvNames: () => Promise<string[]>
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
  listRuntimes: () => Promise<EphemeralVmRuntimeRecord[]>
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
  /** This window's VM checkouts whose creates have not adopted them yet; replaces its last set. */
  publishPendingCheckouts: (checkouts: PendingVmCheckout[]) => void
  listPendingCheckouts: () => Promise<PendingVmCheckout[]>
  /** Every window's pending VM checkouts, whenever any window's set changes. */
  onPendingCheckoutsChanged: (callback: (checkouts: PendingVmCheckout[]) => void) => () => void
}
