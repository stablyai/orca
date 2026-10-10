import { appendFileSync } from 'node:fs'
import type { SshConnectionState } from '../../shared/ssh-types'
import { createCancelledConnectAttemptError } from '../ssh/ssh-connect-attempt-cancellation'
import {
  getSshProviderAuthority,
  isCurrentSshProviderAuthority,
  rotateSshProviderAuthority
} from '../ssh/ssh-provider-authority'
import { adoptSshConnection, runAttributedToSshOwner } from '../ssh/ssh-connection-attribution'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import {
  decideHostServer,
  recheckWhenManagedFenceClears,
  publishHostServerDecisionFailure,
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

export async function connectTarget(targetId: string): Promise<SshConnectionState> {
  const e2eProbePath = process.env.ORCA_E2E_FORBID_LOCAL_SSH_CONNECT_PROBE
  if (e2eProbePath) {
    appendFileSync(e2eProbePath, `${JSON.stringify(targetId)}\n`)
    throw new Error('e2e_forbidden_local_ssh_connect')
  }
  // Why: fence callers that entered before a same-turn disconnect/reset but resume after its cleanup.
  const admissionAuthority = getSshProviderAuthority(targetId)
  await awaitTargetLifecycle(targetId)

  // Why: serialize concurrent ssh:connect for the same target; interleaved connects otherwise leak the first session.
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
  // Why: the shutdown drain fences and snapshots synchronously, so a connect either registers in
  // connectInFlight below (and gets joined) or fails here — it can never slip between the two.
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

  // A transport the decision's census, deploy or conversion opens is attributed to this attempt,
  // so a cancelled attempt closes exactly that one and nothing a newer owner took over.
  const owner = Symbol(targetId)
  // Why after the teardown above: deploy and conversion refuse while a direct session or transport
  // exists, and the authority rotated synchronously so concurrent connects still join this one.
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
    return publishManagedServerConnect(
      targetId,
      server.environmentId,
      server.update,
      server.serving
    )
  }
  // This version has no relay to fall back to: a host its managed server doesn't serve fails here.
  await abandonDecisionTransport(targetId, owner, authority)
  throw publishUnservedHostServer(target, server)
}

function adoptCurrentTransport(targetId: string, owner: symbol): void {
  const current = connectionManager!.getConnection(targetId)
  if (current) {
    adoptSshConnection(current, owner)
  }
}
