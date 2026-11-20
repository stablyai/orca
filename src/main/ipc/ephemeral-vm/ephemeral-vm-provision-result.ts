import type { EphemeralVmProvisionedRuntimeRecord } from '../../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { EphemeralVmRecipeResultWarning } from '../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-recipe-diagnostics'
import type { EphemeralVmFailure } from '../../../shared/remote-runtime/ephemeral-vm-recipes/ephemeral-vm-failure-copy'

export type EphemeralVmProvisionIpcResult =
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
  | ({
      ok: false
      stderr: string
      stdout: string
    } & EphemeralVmFailure)
