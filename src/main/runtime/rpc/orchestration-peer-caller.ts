import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcMethod, RpcRequest, RpcStreamingMethod } from './core'
import type { RpcDispatchStreamingOptions } from './dispatcher-stream-options'
import { OrchestrationError } from '../orchestration/orchestration-error'
import { isGeneratedId } from '../orchestration/db/generated-id'
import { RemoteOwnedPeerRun } from '../../../shared/orchestration/remote-owned-wire'
import {
  peerCoordinatorCaller,
  type OrchestrationPeerCaller
} from '../orchestration/addressing/orchestration-caller-identity'

const NO_EFFECTS = { effectsApplied: false } as const

/**
 * A call a paired Orca makes as the coordinator of one of its Runs here. Admitted from the
 * authenticated runtime pairing, never from a param, and synchronously: its Run is written in the
 * frame's first turn, so a later frame of the same conversation (a cancel) always finds it.
 * The declared caller field then names the peer, as a session's names the session.
 */
export function admitOrchestrationPeerCall(
  runtime: OrcaRuntimeService,
  request: RpcRequest,
  method: RpcMethod | RpcStreamingMethod,
  options: RpcDispatchStreamingOptions | undefined
): { request: RpcRequest; caller: OrchestrationPeerCaller } | undefined {
  if (request.orchestrationPeerRun === undefined) {
    return undefined
  }
  const access = method.orchestrationAccess
  if (!access) {
    throw new OrchestrationError(
      'invalid_argument',
      `${request.method} is not an orchestration method, so it takes no peer Run. No effects were applied.`,
      NO_EFFECTS
    )
  }
  const fingerprint = options?.authenticatedCallerFingerprint
  if (options?.clientKind !== 'runtime' || options.pairedDeviceId === undefined || !fingerprint) {
    throw new OrchestrationError(
      'mail_requires_server_pairing',
      'Only a paired computer can coordinate a Run on this server. No effects were applied.',
      NO_EFFECTS
    )
  }
  const peerRun = RemoteOwnedPeerRun.safeParse(request.orchestrationPeerRun)
  if (!peerRun.success || !isGeneratedId(peerRun.data.conversationId, 'peerconv')) {
    throw new OrchestrationError(
      'invalid_argument',
      'A peer Run needs its Run, conversation ID and label. No effects were applied.',
      NO_EFFECTS
    )
  }
  const caller = peerCoordinatorCaller(
    runtime
      .getOrchestrationDb()
      .admitPeerRun({ peerFingerprint: fingerprint, peerRun: peerRun.data })
  )
  // Terminal attestation and pane keys name callers on the host that has them, never this one.
  const peerRequest = { ...request, orchestrationCompatibilityEvidence: undefined }
  const params: unknown = request.params
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { request: peerRequest, caller }
  }
  const bound: Record<string, unknown> = { ...params }
  if (access.callerPane) {
    delete bound[access.callerPane]
  }
  if (access.caller) {
    bound[access.caller] = caller.address
  }
  return { request: { ...peerRequest, params: bound }, caller }
}
