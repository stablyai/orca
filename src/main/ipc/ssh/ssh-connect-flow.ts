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
  publishManagedServerConnect,
  publishUnservedHostServer
} from './ssh-host-server-connect'
import {
  assertSshConnectsNotFenced,
  connectInFlight,
  isCurrentConnectAttempt
} from './ssh-connect-attempt-registry'
import { connectionManager } from './ssh-ipc-context'
import { abandonDecisionTransport } from './ssh-session-teardown'
import { awaitTargetLifecycle } from './ssh-target-lifecycle-queue'
import { startLegacyRelayBridge } from '../../ssh/legacy-relay/legacy-relay-bridge-registry'
import { clearSshCredentialDeclined } from '../../ssh/ssh-credential-decline'
import {
  createSshUserDisconnectedError,
  isSshUserDisconnected
} from '../../ssh/ssh-user-disconnect'
import {
  liftSshHostUserDisconnect,
  resumeRuntimeEnvironmentStatus
} from './ssh-host-user-disconnect'

/** `automatic`: no user asked for this connect, so a cancelled sign-in or a Disconnect stays. */
export async function connectTarget(
  targetId: string,
  options: { automatic?: boolean } = {}
): Promise<SshConnectionState> {
  const e2eProbePath = process.env.ORCA_E2E_FORBID_LOCAL_SSH_CONNECT_PROBE
  if (e2eProbePath) {
    appendFileSync(e2eProbePath, `${JSON.stringify(targetId)}\n`)
    throw new Error('e2e_forbidden_local_ssh_connect')
  }
  if (options.automatic) {
    // Preserve disconnected status rather than publishing an unwanted failed connect.
    if (isSshUserDisconnected(targetId)) {
      const label = getSshTargetRegistryStore()?.getTarget(targetId)?.label ?? targetId
      throw createSshUserDisconnectedError(label)
    }
    return admitConnect(targetId)
  }
  clearSshCredentialDeclined(targetId)
  // Only explicit user connects may lift the re-pair cap.
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

async function admitConnect(targetId: string): Promise<SshConnectionState> {
  // Fence requests that entered before disconnect/reset but resume after its cleanup.
  const admissionAuthority = getSshProviderAuthority(targetId)
  await awaitTargetLifecycle(targetId)

  // Coalesce concurrent connects to avoid leaking the first session.
  const existing = connectInFlight.get(targetId)
  let replacePendingTransport = false
  if (existing) {
    if (isCurrentConnectAttempt(targetId, existing.authority)) {
      return existing.promise
    }
  }
  if (!isCurrentConnectAttempt(targetId, admissionAuthority)) {
    throw createCancelledConnectAttemptError()
  }
  const observedAuthority = admissionAuthority
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

  const promise = doConnect(targetId, replacePendingTransport)
  const attempt = { authority: getSshProviderAuthority(targetId), promise }
  connectInFlight.set(targetId, attempt)
  try {
    return await promise
  } finally {
    if (connectInFlight.get(targetId) === attempt) {
      connectInFlight.delete(targetId)
    }
  }
}

async function doConnect(
  targetId: string,
  replacePendingTransport = false
): Promise<SshConnectionState> {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (!target) {
    throw new Error(`SSH target "${targetId}" not found`)
  }

  const authority = rotateSshProviderAuthority(targetId)
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
    async (error: unknown) => {
      if (!isCurrentConnectAttempt(targetId, authority)) {
        await abandonDecisionTransport(targetId, owner, authority)
        throw createCancelledConnectAttemptError()
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
    const published = publishManagedServerConnect(
      targetId,
      server.environmentId,
      server.update,
      server.serving,
      server.linked
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
