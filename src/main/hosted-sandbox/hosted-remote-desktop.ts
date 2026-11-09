// "Open Remote Desktop" for an Orca Cloud workspace: the control plane starts the VM's desktop
// (Xvnc + noVNC on the VM's loopback), then the paired runtime connection forwards its port here.
// No public route: the desktop is reachable only through this computer's localhost.
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import {
  cloudRemoteDesktopUrl,
  type CloudRemoteDesktopFailureCode,
  type CloudRemoteDesktopResult
} from '../../shared/hosted-sandbox/cloud-remote-desktop'
import type { RuntimePortForwardOpenRequest } from '../../shared/runtime-port-forwards'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'

export type CloudRemoteDesktopDeps = {
  userDataPath: string
  client: Pick<HostedSandboxControlPlaneClient, 'startDesktop'> | null
  openForward: (
    request: RuntimePortForwardOpenRequest
  ) => Promise<{ ok: true; localPort: number } | { ok: false }>
}

/** The Orca Cloud sandbox behind a paired runtime environment, from the local runtime records. */
export function cloudSandboxIdForEnvironment(
  userDataPath: string,
  environmentId: string
): string | null {
  return cloudSandboxesByEnvironment(userDataPath).get(environmentId) ?? null
}

/** environmentId -> sandboxId for every live Orca Cloud runtime record. */
export function cloudSandboxesByEnvironment(userDataPath: string): Map<string, string> {
  const sandboxes = new Map<string, string>()
  for (const runtime of listEphemeralVmRuntimes(userDataPath)) {
    if (
      !runtime.runtimeEnvironmentId ||
      runtime.recipe?.provider !== 'orca-cloud' ||
      !runtime.recipeResult ||
      ['failed', 'cleanup_pending', 'cleanup_failed', 'cleaned'].includes(runtime.status)
    ) {
      continue
    }
    const handle = environmentHandleFromRecipeResult(runtime.recipeResult, HOSTED_SANDBOX_DRIVER_ID)
    const sandboxId = handle?.driverState.sandboxId
    if (typeof sandboxId === 'string' && sandboxId) {
      sandboxes.set(runtime.runtimeEnvironmentId, sandboxId)
    }
  }
  return sandboxes
}

function failure(code: CloudRemoteDesktopFailureCode): CloudRemoteDesktopResult {
  return { ok: false, code }
}

function startFailure(error: unknown): CloudRemoteDesktopResult {
  if (isEnvironmentProviderError(error, 'conflict')) {
    return failure(error.reason === 'desktop_not_installed' ? 'not_installed' : 'not_running')
  }
  if (isEnvironmentProviderError(error, 'unauthorized')) {
    return failure('signed_out')
  }
  return failure('unavailable')
}

export async function openCloudRemoteDesktop(
  deps: CloudRemoteDesktopDeps,
  environmentId: string
): Promise<CloudRemoteDesktopResult> {
  const sandboxId = cloudSandboxIdForEnvironment(deps.userDataPath, environmentId)
  if (!sandboxId || !deps.client) {
    return failure('not_cloud')
  }
  let desktop: { port: number; path: string; password: string }
  try {
    desktop = await deps.client.startDesktop(sandboxId)
  } catch (error) {
    return startFailure(error)
  }
  // Same local number when free (stable bookmarks), else the next free one.
  const forward = await deps.openForward({
    environmentId,
    remotePort: desktop.port,
    reason: 'user',
    label: 'Remote Desktop'
  })
  if (!forward.ok) {
    return failure('forward_failed')
  }
  return {
    ok: true,
    localPort: forward.localPort,
    url: cloudRemoteDesktopUrl(forward.localPort, desktop.path, desktop.password)
  }
}
