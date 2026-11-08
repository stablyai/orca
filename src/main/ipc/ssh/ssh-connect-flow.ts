import { appendFileSync } from 'node:fs'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { createCancelledConnectAttemptError } from '../../ssh/ssh-connect-attempt-cancellation'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  rotateSshProviderAuthority
} from '../../ssh/ssh-provider-authority'
import {
  adoptSshConnection,
  runAttributedToSshOwner
} from '../../ssh/connection/ssh-connection-attribution'
import { getSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { noteRuntimeEnvironmentConnectRequested } from '../runtime-environments/runtime-environment-pairing-refusal-registry'
import {
  decideHostServer,
  recheckWhenManagedFenceClears,
  publishHostServerDecisionFailure,
  publishBridgedUnservedHostServer,
  restoreKeptHostServer,
  publishManagedServerConnect,
  publishUnservedHostServer
} from './ssh-host-server-connect'
import {
  admittedConnectAuthority,
  assertSshConnectsNotFenced,
  type ConnectAttempt,
  type QuietConnect,
  connectInFlight,
  isCurrentConnectAttempt
} from './ssh-connect-attempt-registry'
import { connectionManager } from './ssh-ipc-context'
import { abandonDecisionTransport } from './ssh-session-teardown'
import { awaitTargetLifecycle } from './ssh-target-lifecycle-queue'
import { startLegacyRelayBridge } from '../../ssh/legacy-relay/legacy-relay-bridge-registry'
import {
  getSshHostServerStatus,
  isSshHostKeptForBridgedTerminals
} from '../../ssh/ssh-host-server-status'
import type { HostServerOnConnectResult } from '../../ssh/ssh-host-server-on-connect'
import { clearSshCredentialDeclined } from '../../ssh/ssh-credential-decline'
import {
  createSshUserDisconnectedError,
  isSshUserDisconnected
} from '../../ssh/ssh-user-disconnect'
import {
  isManagedServerRemovalHeld,
  liftSshHostUserDisconnect,
  resumeRuntimeEnvironmentStatus
} from './ssh-host-user-disconnect'

/**
 * `automatic`: no user asked for this connect, so a cancelled sign-in or a Disconnect stays.
 * `quiet` (implies automatic): retry a bridged host's move; refusal keeps the host as it was.
 */
export async function connectTarget(
  targetId: string,
  options: { automatic?: boolean; quiet?: boolean } = {}
): Promise<SshConnectionState> {
  const e2eProbePath = process.env.ORCA_E2E_FORBID_LOCAL_SSH_CONNECT_PROBE
  if (e2eProbePath) {
    appendFileSync(e2eProbePath, `${JSON.stringify(targetId)}\n`)
    throw new Error('e2e_forbidden_local_ssh_connect')
  }
  if (options.automatic || options.quiet) {
    // Preserve disconnected status rather than publishing an unwanted failed connect.
    if (isSshUserDisconnected(targetId)) {
      const label = getSshTargetRegistryStore()?.getTarget(targetId)?.label ?? targetId
      throw createSshUserDisconnectedError(label)
    }
    return admitConnect(targetId, true, options.quiet === true)
  }
  clearSshCredentialDeclined(targetId)
  // Only explicit user connects may lift the re-pair and crash-loop caps.
  const managedEnvironmentId = getManagedOrcadFenceEnvironmentId(
    getSshTargetRegistryStore()?.getTarget(targetId)
  )
  if (managedEnvironmentId) {
    noteRuntimeEnvironmentConnectRequested(managedEnvironmentId)
  }
  const liftedEnvironments = liftSshHostUserDisconnect(targetId)
  try {
    return await admitConnect(targetId)
  } finally {
    resumeRuntimeEnvironmentStatus(liftedEnvironments)
  }
}

async function admitConnect(
  targetId: string,
  automatic = false,
  quiet = false
): Promise<SshConnectionState> {
  // Fence requests that entered before disconnect/reset but resume after its cleanup.
  const admissionAuthority = getSshProviderAuthority(targetId)
  await awaitTargetLifecycle(targetId)

  // Coalesce concurrent connects to avoid leaking the first session.
  const existing = connectInFlight.get(targetId)
  let replacePendingTransport = false
  if (existing) {
    if (isCurrentConnectAttempt(targetId, existing.authority)) {
      // A user's connect joining a quiet retry makes it an ordinary connect (#29626).
      if (!quiet && existing.quiet) {
        existing.quiet.active = false
      }
      return existing.promise
    }
  }
  const observedAuthority = admittedConnectAuthority(targetId, admissionAuthority)
  if (!observedAuthority) {
    throw createCancelledConnectAttemptError()
  }
  if (existing) {
    if (connectInFlight.get(targetId) === existing) {
      connectInFlight.delete(targetId)
      replacePendingTransport = true
    }
  }
  if (!isCurrentSshProviderAuthority(observedAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  // Shutdown fences and snapshots synchronously; register below or fail here without an admission gap.
  assertSshConnectsNotFenced()

  let registered: ConnectAttempt | undefined
  const quietMode: QuietConnect | undefined = quiet
    ? {
        active: true,
        rotated: (authority) => {
          if (registered) {
            registered.authority = authority
          }
        }
      }
    : undefined
  const promise = quietMode
    ? doQuietConnect(targetId, replacePendingTransport, quietMode)
    : doConnect(targetId, replacePendingTransport, automatic)
  const attempt: ConnectAttempt = {
    authority: getSshProviderAuthority(targetId),
    promise,
    ...(quietMode ? { quiet: quietMode } : {})
  }
  registered = attempt
  connectInFlight.set(targetId, attempt)
  try {
    return await promise
  } finally {
    if (connectInFlight.get(targetId) === attempt) {
      connectInFlight.delete(targetId)
    }
  }
}

/** COMPAT(legacy-relay-bridge): only a finished move publishes; any other outcome restores the kept host. */
async function doQuietConnect(
  targetId: string,
  replacePendingTransport: boolean,
  quiet: QuietConnect
): Promise<SshConnectionState> {
  // Replacing a pending transport would hang up the session the kept host still uses.
  if (
    replacePendingTransport ||
    !isSshHostKeptForBridgedTerminals(getSshHostServerStatus(targetId)) ||
    connectionManager!.getState(targetId)?.status !== 'connected'
  ) {
    throw createCancelledConnectAttemptError()
  }
  return doConnect(targetId, false, true, quiet)
}

async function doConnect(
  targetId: string,
  replacePendingTransport = false,
  automatic = false,
  quiet?: QuietConnect
): Promise<SshConnectionState> {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (!target) {
    throw new Error(`SSH target "${targetId}" not found`)
  }
  // Read after the lifecycle wait: a Stop or Forget this connect queued behind wrote the hold.
  if (automatic && isManagedServerRemovalHeld(target)) {
    throw createSshUserDisconnectedError(target.label)
  }

  // A quiet retry rotates only once its move succeeds; a refusal must not cancel provider requests.
  let authority = quiet ? getSshProviderAuthority(targetId) : rotateSshProviderAuthority(targetId)
  if (replacePendingTransport) {
    await connectionManager!.disconnect(targetId)
    if (!isCurrentConnectAttempt(targetId, authority)) {
      throw createCancelledConnectAttemptError()
    }
  }

  // Attribute decision-created transports so cancellation closes only those not adopted by a newer owner.
  const owner = Symbol(targetId)
  // Deploy/conversion require teardown first; rotated authority still lets concurrent connects join.
  const server = await runAttributedToSshOwner(owner, () => decideHostServer(target)).catch(
    async (error: unknown): Promise<HostServerOnConnectResult> => {
      if (!isCurrentConnectAttempt(targetId, authority)) {
        await abandonDecisionTransport(targetId, owner, authority)
        throw createCancelledConnectAttemptError()
      }
      if (quiet?.active) {
        // The host is still connected and bridged; a retry no one asked for surfaces no failure.
        assertSshConnectsNotFenced()
        console.warn(`[ssh] Retried move for ${targetId} failed; the host stays as it was:`, error)
        return { route: 'unserved', reason: 'refused' }
      }
      // A failed setup leaves no relay to own the transport its decision dialed.
      await abandonDecisionTransport(targetId, owner, authority)
      publishHostServerDecisionFailure(targetId, error)
      throw error
    }
  )
  // A shutdown that began during the decision is the actionable reason, ahead of the rotation.
  assertSshConnectsNotFenced()
  if (!isCurrentConnectAttempt(targetId, authority)) {
    await abandonDecisionTransport(targetId, owner, authority)
    throw createCancelledConnectAttemptError()
  }
  adoptCurrentTransport(targetId, owner)
  if (quiet?.active && server.route === 'unserved' && !server.bridged) {
    // COMPAT(legacy-relay-bridge): only a finished move replaces the kept host's status.
    return restoreKeptHostServer(targetId)
  }
  if (server.route === 'managed') {
    if (server.fenceHeld) {
      recheckWhenManagedFenceClears(target, server.environmentId)
    }
    // COMPAT(legacy-relay-bridge): panes an older relay still runs are known before the host is.
    await startLegacyRelayBridge(targetId)
    // A disconnect or shutdown during the bridge wait already published; "connected" would be stale.
    assertSshConnectsNotFenced()
    if (!isCurrentConnectAttempt(targetId, authority)) {
      await abandonDecisionTransport(targetId, owner, authority)
      throw createCancelledConnectAttemptError()
    }
    if (quiet) {
      authority = rotateSshProviderAuthority(targetId)
      quiet.rotated(authority)
    }
    const published = publishManagedServerConnect(
      targetId,
      server.environmentId,
      server.update,
      server.serving,
      server.linked,
      server.automationsLeftDisabled
    )
    // Publish first; the macOS-only check adds remote round trips.
    void import('./ssh-host-launch-session-note')
      .then(({ noteEndedLaunchSshSession }) =>
        noteEndedLaunchSshSession(targetId, server.environmentId)
      )
      .catch(() => {})
    return published
  }
  if (server.bridged) {
    // COMPAT(legacy-relay-bridge): the move waits for relay terminals the bridge keeps serving.
    await startLegacyRelayBridge(targetId)
    assertSshConnectsNotFenced()
    if (!isCurrentConnectAttempt(targetId, authority)) {
      await abandonDecisionTransport(targetId, owner, authority)
      throw createCancelledConnectAttemptError()
    }
    return publishBridgedUnservedHostServer(target, server)
  }
  // Unserved hosts have no relay fallback.
  await abandonDecisionTransport(targetId, owner, authority)
  throw publishUnservedHostServer(target, server)
}

function adoptCurrentTransport(targetId: string, owner: symbol): void {
  const current = connectionManager!.getConnection(targetId)
  if (current) {
    adoptSshConnection(current, owner)
  }
}
