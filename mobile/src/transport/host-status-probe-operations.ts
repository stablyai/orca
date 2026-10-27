import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'
import { hostStatusSchema, type HostStatusReply } from './host-status-reply-schema'
import type { RpcResponse } from './types'

// Transport callers share refusal-as-no-answer policy but differ in fallback/retry consequences; keep this boundary independent of tasks.
// Readers below catch decode errors because throws in fulfillment callbacks would become detached rejections and strand probe/race state.
export const hostStatusProbe = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'status.transport-probe-or-skip',
    method: 'status.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-status', hostStatusSchema)
  })
)

// Return null for refusal, but {status:null} for unreadable success to preserve the probe’s stop-versus-backoff behavior.
export function readProbedHostStatus(
  reply: RpcResponse
): { status: HostStatusReply | null } | null {
  try {
    const accepted = hostStatusProbe.interpret(reply)
    return accepted.accepted ? { status: accepted.value } : null
  } catch {
    return { status: null }
  }
}

export function readProbedHostCapabilities(reply: RpcResponse): readonly string[] | null {
  const landed = readProbedHostStatus(reply)
  return landed ? (landed.status?.capabilities ?? []) : null
}

// An unreadable successful reply still proves the candidate socket answered; only refusal means the path failed.
export function hostAnsweredStatusProbe(reply: RpcResponse): boolean {
  try {
    return hostStatusProbe.interpret(reply).accepted
  } catch {
    return true
  }
}

// Never throw in the race’s fulfillment handler; unreadable answers carry null status rather than stranding the candidate.
export function readPairingCandidateStatus(reply: RpcResponse): HostStatusReply | null {
  return readProbedHostStatus(reply)?.status ?? null
}
