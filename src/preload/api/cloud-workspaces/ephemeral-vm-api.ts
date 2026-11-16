import type { OrcaHooks } from '../../../shared/workspace-setup/orca-yaml-hook-types'
import type { EphemeralVmRecipeDoctorResult } from '../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipes'
import type {
  EphemeralVmRuntimeRecord,
  EphemeralVmWorkspaceLifecycleResult
} from '../../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import type { RecipeEnvironmentProvisionResult } from '../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-environment-provision-result'
import type { PendingVmCheckout } from '../../../shared/remote-runtime/ephemeral-vm-store/pending-vm-checkouts'

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
  }) => Promise<RecipeEnvironmentProvisionResult>
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
