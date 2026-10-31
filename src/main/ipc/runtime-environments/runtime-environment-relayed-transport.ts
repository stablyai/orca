import { z } from 'zod'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../shared/mobile-desktop-relay-contract'
import {
  parseRelayedRuntimeEnvironmentId,
  RELAYED_RUNTIME_READ_METHODS,
  type RelayedRuntimeEnvironment
} from '../../../shared/relayed-runtime-environment'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { RuntimeEnvironmentStoreError } from '../../../shared/runtime-environment-store-records'
import {
  getPreferredPairedRuntimeConnection,
  isWslHostRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { RuntimeRpcCallQueueOverloadError } from '../../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { manuallyDisconnectedResponse } from './runtime-environment-call-failure'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import { resolveManagedRuntimeEnvironment } from './runtime-environment-managed-tunnel'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { sendRemoteRuntimeSharedControlRequestWhenAdmitted } from './runtime-environment-request-connections'
import type { SharedControlAdmission } from './runtime-environment-shared-control-admission'
import { runtimeEnvironmentChangedFailure } from './runtime-environment-revision-guard'

const DEFAULT_RELAYED_TIMEOUT_MS = 15_000
// One re-probe covers a reconnect between the gate and the send; a flapping socket fails instead.
const MAX_GATE_ATTEMPTS = 2

/** A advertises the relay per socket, so a reconnect or re-pair re-proves it before the next send. */
const RELAY_ADMISSION: SharedControlAdmission = {
  admits: (status) => (status.capabilities ?? []).includes(RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY),
  cache: new WeakMap()
}

type RelayedRuntimeCall = {
  selector: string
  method: string
  params?: unknown
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

function relayedFailure(method: string, code: string, message: string): RuntimeRpcFailure {
  return { id: method, ok: false, error: { code, message }, _meta: { runtimeId: null } }
}

/** Answers a renderer call on a `relay:` environment through the paired server that relays to it. */
export async function callRelayedRuntimeEnvironment(
  userDataPath: string,
  call: RelayedRuntimeCall
): Promise<RuntimeRpcResponse<unknown>> {
  const response = await relayedCall(userDataPath, call)
  return call.method === 'status.get' ? checkedRelayedStatus(response) : response
}

/** The relayed server's own status; never A's, which would gate B's workspaces on A's features. */
export async function getRelayedRuntimeEnvironmentStatus(
  userDataPath: string,
  selector: string,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<RuntimeStatus>> {
  return checkedRelayedStatus(
    await relayedCall(userDataPath, { selector, method: 'status.get', timeoutMs })
  )
}

const RelayedStatusSchema = z.looseObject({
  runtimeId: z.string(),
  capabilities: z.array(z.string()).optional()
})

function checkedRelayedStatus(
  response: RuntimeRpcResponse<unknown>
): RuntimeRpcResponse<RuntimeStatus> {
  if (!response.ok) {
    return response
  }
  const parsed = RelayedStatusSchema.safeParse(response.result)
  if (!parsed.success) {
    return relayedFailure('status.get', 'invalid_runtime_response', 'Malformed relayed status')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: B's status.get handler built it; the parse proved the identity and capability fields read before anything else.
  return { ...response, result: parsed.data as RuntimeStatus }
}

async function relayedCall(
  userDataPath: string,
  call: RelayedRuntimeCall
): Promise<RuntimeRpcResponse<unknown>> {
  const relayed = parseRelayedRuntimeEnvironmentId(call.selector)
  if (!relayed) {
    return relayedFailure(call.method, 'invalid_argument', 'Unknown relayed server')
  }
  // Mutations, terminals and browser stay out until the relay route table and child scope are settled.
  if (!RELAYED_RUNTIME_READ_METHODS.has(call.method)) {
    return relayedFailure(
      call.method,
      'forbidden',
      `${call.method} is not available on a server reached through another server`
    )
  }
  // A relayed server's runtime can't be proven before the send, so a retry would be refused the same way.
  if (call.expectedEnvironmentRuntimeId !== undefined) {
    return relayedFailure(call.method, 'forbidden', "A runtime can't be pinned through a relay")
  }
  try {
    return await enqueueRuntimeCall(call.selector, call.method, () =>
      sendThroughOwner(userDataPath, relayed, call)
    )
  } catch (error) {
    if (
      error instanceof RemoteRuntimeClientError ||
      error instanceof RuntimeRpcCallQueueOverloadError
    ) {
      return relayedFailure(call.method, error.code, error.message)
    }
    // Unpaired since the id was minted: the server it named is gone, not this call's fault.
    if (error instanceof RuntimeEnvironmentStoreError) {
      return runtimeEnvironmentChangedFailure({ runtimeId: null }, call.method, true)
    }
    throw error
  }
}

async function sendThroughOwner(
  userDataPath: string,
  relayed: RelayedRuntimeEnvironment,
  call: RelayedRuntimeCall
): Promise<RuntimeRpcResponse<unknown>> {
  // One budget for the caller's timeout: tunnel repair, gate probe and read, across both attempts.
  const deadline = Date.now() + (call.timeoutMs ?? DEFAULT_RELAYED_TIMEOUT_MS)
  const remainingMs = (): number => Math.max(0, deadline - Date.now())
  const owner = resolveEnvironment(userDataPath, relayed.ownerEnvironmentId)
  const pairingRevision = owner.pairingRevision ?? owner.createdAt
  if (
    pairingRevision !== relayed.ownerPairingRevision ||
    (call.expectedEnvironmentPairingRevision !== undefined &&
      call.expectedEnvironmentPairingRevision !== relayed.ownerPairingRevision)
  ) {
    return runtimeEnvironmentChangedFailure({ runtimeId: null }, call.method, true)
  }
  if (isRuntimeEnvironmentManuallyDisconnected(owner.id)) {
    // A's runtime id must not stamp a reply for the relayed server.
    return manuallyDisconnectedResponse({ runtimeId: null })
  }
  // WSL distros connect only for work open on this computer; they never relay.
  if (isWslHostRuntimeEnvironment(owner)) {
    return relayedFailure(call.method, 'forbidden', 'This server does not relay to other servers')
  }
  const current = await resolveManagedRuntimeEnvironment(userDataPath, owner.id)
  if ((current.pairingRevision ?? current.createdAt) !== relayed.ownerPairingRevision) {
    return runtimeEnvironmentChangedFailure({ runtimeId: null }, call.method, true)
  }
  const connection = getPreferredPairedRuntimeConnection(current)
  for (let attempt = 0; attempt < MAX_GATE_ATTEMPTS; attempt += 1) {
    // Never bypass the gate: no one-shot fallback, and A must not record B's runtime as its own.
    const sent = await sendRemoteRuntimeSharedControlRequestWhenAdmitted<unknown>(
      current.id,
      connection,
      {
        method: call.method,
        params: call.params,
        remainingMs,
        envelope: { executionHost: relayed.executionHost }
      },
      RELAY_ADMISSION
    )
    if (sent.kind === 'sent') {
      return sent.response
    }
    // A's own error (e.g. busy), not proof it can't relay; the next call asks again.
    if (sent.kind === 'status_failed') {
      return relayedFailure(call.method, sent.response.error.code, sent.response.error.message)
    }
    // Without the capability A would answer the call itself: a read from the wrong machine.
    if (sent.kind === 'refused') {
      return relayedFailure(
        call.method,
        'remote_runtime_unavailable',
        `${current.name} does not relay to its servers; update Orca on ${current.name}`
      )
    }
  }
  return relayedFailure(
    call.method,
    'remote_runtime_unavailable',
    `The connection to ${current.name} kept changing; nothing was sent`
  )
}
