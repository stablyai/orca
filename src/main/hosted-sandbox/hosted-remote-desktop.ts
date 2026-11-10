// "Open Remote Desktop" for an Orca Cloud workspace: the control plane starts the VM's desktop
// (Xvnc + noVNC on the VM's loopback), then the paired runtime connection forwards its port here.
// No public route: the desktop is reachable only through this computer's localhost, and each
// WebSocket to it needs a single-use ticket that main hands the page (remote-desktop-guest.ts).
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import {
  cloudRemoteDesktopUrl,
  type CloudRemoteDesktopFailureCode,
  type CloudRemoteDesktopResult
} from '../../shared/hosted-sandbox/cloud-remote-desktop'
import type { HostedSandboxDesktop } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { RuntimePortForwardOpenRequest } from '../../shared/runtime-port-forwards'
import { isEnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { environmentHandleFromRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { HOSTED_SANDBOX_DRIVER_ID } from './hosted-sandbox-driver'
import {
  registerRemoteDesktopSession,
  type RemoteDesktopMintFailure,
  type RemoteDesktopMintResult
} from './remote-desktop-sessions'

export type CloudRemoteDesktopDeps = {
  userDataPath: string
  client: Pick<HostedSandboxControlPlaneClient, 'startDesktop'> | null
  openForward: (
    request: RuntimePortForwardOpenRequest
  ) => Promise<{ ok: true; localPort: number } | { ok: false }>
  now?: () => number
  /** Whether this computer still forwards localPort to the environment's remotePort. */
  isForwardLive?: (forward: {
    environmentId: string
    localPort: number
    remotePort: number
  }) => boolean
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

const ASLEEP_REASONS = new Set(['sandbox_suspended', 'sandbox_suspending'])
const STARTING_REASONS = new Set(['sandbox_creating', 'sandbox_resuming'])

/** How a desktop start (or ticket) failure reads; a conflict names the sandbox's state. */
function startFailureCode(error: unknown): CloudRemoteDesktopFailureCode {
  if (isEnvironmentProviderError(error, 'conflict')) {
    const reason = error.reason ?? ''
    if (reason === 'desktop_not_installed') {
      return 'not_installed'
    }
    if (reason === 'sandbox_archived') {
      return 'archived'
    }
    if (ASLEEP_REASONS.has(reason)) {
      return 'not_running'
    }
    return STARTING_REASONS.has(reason) ? 'starting' : 'unavailable'
  }
  return isEnvironmentProviderError(error, 'unauthorized') ? 'signed_out' : 'unavailable'
}

const MINT_FAILURE: Partial<Record<CloudRemoteDesktopFailureCode, RemoteDesktopMintFailure>> = {
  not_running: 'asleep',
  archived: 'archived',
  starting: 'starting',
  signed_out: 'signed_out'
}

export async function openCloudRemoteDesktop(
  deps: CloudRemoteDesktopDeps,
  environmentId: string
): Promise<CloudRemoteDesktopResult> {
  const sandboxId = cloudSandboxIdForEnvironment(deps.userDataPath, environmentId)
  const client = deps.client
  if (!sandboxId || !client) {
    return failure('not_cloud')
  }
  const now = deps.now ?? Date.now
  let desktop: HostedSandboxDesktop
  try {
    desktop = await client.startDesktop(sandboxId)
  } catch (error) {
    return failure(startFailureCode(error))
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
  // Each later WebSocket (a reload, a reconnect after a drop or a wake) gets its own ticket.
  const mint = async (): Promise<RemoteDesktopMintResult> => {
    try {
      const next = await client.startDesktop(sandboxId)
      return { ok: true, ticket: next.ticket, expiresAt: now() + next.expiresInMs }
    } catch (error) {
      return { ok: false, reason: MINT_FAILURE[startFailureCode(error)] ?? 'unavailable' }
    }
  }
  const isForwardLive = deps.isForwardLive
  const live = { environmentId, localPort: forward.localPort, remotePort: desktop.port }
  registerRemoteDesktopSession(
    {
      environmentId,
      localPort: forward.localPort,
      path: desktop.path,
      mint,
      ...(isForwardLive ? { isLive: () => isForwardLive(live) } : {})
    },
    { ticket: desktop.ticket, expiresAt: now() + desktop.expiresInMs }
  )
  return {
    ok: true,
    localPort: forward.localPort,
    url: cloudRemoteDesktopUrl(forward.localPort, desktop.path)
  }
}
