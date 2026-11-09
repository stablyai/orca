// Which of this desktop's recipe VMs are Orca Cloud workspaces, and finding one by what a user or
// ssh_config names it.
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultProjectRoot } from '../../shared/ephemeral-vm-recipes'
import type { CloudSshErrorCode, CloudSshFailure } from '../../shared/cloud-ssh'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import { HOSTED_SANDBOX_DRIVER_ID } from '../hosted-sandbox/hosted-sandbox-driver'

export class CloudSshError extends Error {
  constructor(
    readonly code: CloudSshErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CloudSshError'
  }

  toFailure(): CloudSshFailure {
    return { ok: false, code: this.code, message: this.message }
  }
}

export function cloudSshFailure(error: unknown): CloudSshFailure {
  return error instanceof CloudSshError
    ? error.toFailure()
    : {
        ok: false,
        code: 'control_plane',
        message: error instanceof Error ? error.message : String(error)
      }
}

/** Control-plane refusals in the terms the menu and CLI explain. */
export function controlPlaneError(error: unknown): CloudSshError {
  if (isEnvironmentProviderError(error)) {
    if (error.code === 'conflict' && error.reason === 'ssh_unsupported_image') {
      return new CloudSshError(
        'unsupported_image',
        'This workspace was created before Orca Cloud supported SSH. Create a new workspace to use SSH.'
      )
    }
    if (error.code === 'conflict') {
      return new CloudSshError('asleep', 'The workspace went to sleep. Try again to wake it.')
    }
    return new CloudSshError('control_plane', error.message)
  }
  return new CloudSshError(
    'control_plane',
    error instanceof Error ? error.message : 'Orca Cloud did not answer.'
  )
}

export type CloudWorkspace = {
  runtime: EphemeralVmRuntimeRecord
  runtimeId: string
  sandboxId: string
  runtimeEnvironmentId: string
  projectRoot: string
}

function isLive(runtime: EphemeralVmRuntimeRecord): boolean {
  return runtime.status !== 'cleaned' && runtime.status !== 'cleanup_pending'
}

export function listCloudWorkspaces(
  runtimes: readonly EphemeralVmRuntimeRecord[]
): CloudWorkspace[] {
  return runtimes.flatMap((runtime) => {
    if (runtime.recipe?.provider !== 'orca-cloud' || !isLive(runtime) || !runtime.recipeResult) {
      return []
    }
    const handle = environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    if (!handle || !runtime.runtimeEnvironmentId) {
      return []
    }
    return [
      {
        runtime,
        runtimeId: runtime.id,
        sandboxId: handle.environmentId,
        runtimeEnvironmentId: runtime.runtimeEnvironmentId,
        projectRoot: getEphemeralVmRecipeResultProjectRoot(runtime.recipeResult) ?? '/'
      }
    ]
  })
}

/** By runtime id, workspace id, sandbox id, environment id, SSH alias, or unique workspace name. */
export function resolveCloudWorkspace(
  runtimes: readonly EphemeralVmRuntimeRecord[],
  selector: string,
  aliasOwner: (alias: string) => string | undefined
): CloudWorkspace {
  const wanted = selector.trim()
  const workspaces = listCloudWorkspaces(runtimes)
  const ownerOfAlias = aliasOwner(wanted)
  const exact = workspaces.find(
    (ws) =>
      ws.runtimeId === wanted ||
      ws.runtime.workspaceId === wanted ||
      ws.sandboxId === wanted ||
      ws.runtimeEnvironmentId === wanted ||
      ws.runtimeId === ownerOfAlias
  )
  if (exact) {
    return exact
  }
  const byName = workspaces.filter(
    (ws) => ws.runtime.workspaceName?.toLowerCase() === wanted.toLowerCase()
  )
  if (byName.length === 1) {
    return byName[0]!
  }
  if (byName.length > 1) {
    throw new CloudSshError(
      'not_found',
      `More than one Orca Cloud workspace is named "${wanted}". Use its SSH host name instead.`
    )
  }
  const isOtherVm = runtimes.some((runtime) => isLive(runtime) && runtime.workspaceId === wanted)
  throw isOtherVm
    ? new CloudSshError('not_cloud', 'SSH access is available for Orca Cloud workspaces only.')
    : new CloudSshError('not_found', `No Orca Cloud workspace matches "${wanted}".`)
}
