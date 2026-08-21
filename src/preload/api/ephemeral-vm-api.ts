import type { MCodeHooks } from '../../shared/mcode-yaml-hook-types'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { EphemeralVmRecipeDoctorResult } from '../../shared/ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from '../../shared/ephemeral-vm-recipe-diagnostics'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'

export type EphemeralVmApi = {
  listRecipes: (args: { repoId: string }) => Promise<{
    status: 'ok' | 'error'
    repoPath: string | null
    recipes: MCodeHooks['environmentRecipes']
    diagnostics: NonNullable<MCodeHooks['environmentRecipeDiagnostics']>
    message?: string
  }>
  listRecipeCatalog: () => Promise<
    {
      repoId: string
      repoName: string
      repoPath: string
      recipes: NonNullable<MCodeHooks['environmentRecipes']>
      diagnostics: NonNullable<MCodeHooks['environmentRecipeDiagnostics']>
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
        connectionType: 'mcode-server'
        runtime: EphemeralVmRuntimeRecord
        environment: PublicKnownRuntimeEnvironment
        stderr: string
        warnings: EphemeralVmRecipeResultWarning[]
      }
    | {
        ok: true
        connectionType: 'ssh'
        runtime: EphemeralVmRuntimeRecord
        sshTargetId: string
        expectedRefHead?: string
        stderr: string
        warnings: EphemeralVmRecipeResultWarning[]
      }
    | { ok: false; error: string; stderr: string; stdout: string }
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
  suspendWorkspace: (args: { workspaceId: string }) => Promise<EphemeralVmRuntimeRecord | null>
  resumeWorkspace: (args: { workspaceId: string }) => Promise<EphemeralVmRuntimeRecord | null>
  cleanup: (args: { runtimeId: string }) => Promise<EphemeralVmRuntimeRecord>
  stopCleanup: (args: { runtimeId: string }) => Promise<EphemeralVmRuntimeRecord>
  getCleanupCommand: (args: { runtimeId: string }) => Promise<{
    runtimeId: string
    command: string | null
    payloadJson: string
    cleanupDisabled: boolean
    message?: string
  }>
}
