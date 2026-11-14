import { isOrchestrationMutation } from '../../../../../shared/orchestration/orchestration-rpc-contract'
import { OrchestrationError } from '../../orchestration-error'

/** Off, asleep or off the network: the server gave no answer at all. */
export const REMOTE_SERVER_UNREACHABLE_CODES = ['remote_runtime_unavailable', 'runtime_timeout']

export function isRemoteServerUnreachable(error: unknown): boolean {
  return unreachableCode(error) !== undefined
}

function unreachableCode(error: unknown): string | undefined {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return typeof code === 'string' && REMOTE_SERVER_UNREACHABLE_CODES.includes(code)
    ? code
    : undefined
}

/**
 * A command about a remote worker that its server never answered, said in terms of that server. A
 * change may still have landed there, so its outcome is unknown here. An answer, the server's own
 * `operation_unknown` included, is the server's to explain and is returned unchanged.
 */
export function explainRemoteServerFailure(
  error: unknown,
  call: { server: string; method: string; params: unknown; dispatchId?: string }
): unknown {
  const code = unreachableCode(error)
  if (!code || !(error instanceof Error)) {
    return error
  }
  const { server, dispatchId } = call
  const show = `worker-show${dispatchId ? ` --dispatch ${dispatchId}` : ''}`
  const message = isOrchestrationMutation(call.method, call.params)
    ? `${server} did not answer (${error.message}), so this Orca cannot tell whether the command reached it. Make sure Orca is running on ${server} and check with ${show}. Retry only with the same request ID (--retry-request); a new command could apply it twice.`
    : `${server} could not be reached (${error.message}). Make sure Orca is running on ${server}, then try again.${dispatchId ? ` Meanwhile ${show} gives this Orca's last record of the worker; its output is kept only on ${server}.` : ''}`
  const data = 'data' in error && error.data && typeof error.data === 'object' ? error.data : {}
  return new OrchestrationError(code, message, { ...data, server, reachable: false })
}
