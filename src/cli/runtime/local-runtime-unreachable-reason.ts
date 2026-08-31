import type {
  CliRuntimeUnreachableCode,
  CliRuntimeUnreachableReason
} from '../../shared/runtime-types'
import type { RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import { RuntimeClientError, RuntimeRpcFailureError, RuntimeTransportError } from './types'

/**
 * Why: STA-3969 — `orca status` used to swallow every local RPC failure and report
 * `starting`, so a CLI that could not reach the runtime looked identical to one
 * waiting on a runtime that was genuinely still coming up. The runtime publishes
 * `orca-runtime.json` only *after* its transport is listening (RuntimeRpc.start),
 * so once metadata names an endpoint, a failure to talk to that endpoint is never
 * evidence of a start still in progress. Name the failure instead.
 */
export function classifyLocalRuntimeUnreachable(
  error: unknown,
  transport: RuntimeTransportMetadata,
  timeoutMs: number
): CliRuntimeUnreachableReason {
  const endpoint = transport.endpoint
  const endpointKind = transport.kind === 'named-pipe' ? 'named-pipe' : 'unix'
  const noun = endpointKind === 'named-pipe' ? 'named pipe' : 'socket'
  const osErrorCode = error instanceof RuntimeTransportError ? error.osErrorCode : null
  const code = resolveCode(error, osErrorCode)
  return {
    code,
    message:
      code === 'request_rejected' && error instanceof RuntimeRpcFailureError
        ? `The runtime at ${endpoint} answered but refused the status request (${error.response.error.code}): ${error.response.error.message}`
        : describe(code, { endpoint, noun, timeoutMs }),
    endpoint,
    endpointKind,
    ...(osErrorCode ? { osErrorCode } : {})
  }
}

function resolveCode(error: unknown, osErrorCode: string | null): CliRuntimeUnreachableCode {
  // Why: a runtime that answers and declines is not unreachable in the transport
  // sense — keep it distinct so "fix your sandbox" advice never lands on an auth
  // or version rejection.
  if (error instanceof RuntimeRpcFailureError) {
    return 'request_rejected'
  }
  if (error instanceof RuntimeTransportError && error.phase === 'peer_closed') {
    return 'connection_closed'
  }
  switch (osErrorCode) {
    case 'ENOENT':
      return 'endpoint_missing'
    case 'EACCES':
    case 'EPERM':
      return 'endpoint_permission_denied'
    case 'ECONNREFUSED':
      return 'connection_refused'
    case 'EPIPE':
    case 'ECONNRESET':
      return 'connection_closed'
    case null:
    default:
      break
  }
  if (error instanceof RuntimeClientError) {
    if (error.code === 'runtime_timeout') {
      return 'request_timeout'
    }
    if (error.code === 'invalid_runtime_response') {
      return 'invalid_response'
    }
  }
  return 'unknown'
}

// Why: every branch names the endpoint and states only what was observed. The
// sandbox/session wording is a list of possibilities, not a verdict — the CLI
// cannot see why the OS hid the endpoint, and must not claim it can.
function describe(
  code: CliRuntimeUnreachableCode,
  ctx: { endpoint: string; noun: string; timeoutMs: number }
): string {
  const { endpoint, noun, timeoutMs } = ctx
  switch (code) {
    case 'endpoint_missing':
      return `Orca published the ${noun} ${endpoint}, but it does not exist for this process. Either the runtime shut its endpoint down, or this process cannot see it — a sandbox, container, or different user session each hide it this way. Run the CLI as the same user and outside any sandbox, or restart Orca.`
    case 'endpoint_permission_denied':
      return `The OS denied this process access to the ${noun} ${endpoint}. Run the CLI as the same user that runs Orca, outside any sandbox that restricts ${noun} access.`
    case 'connection_refused':
      return `The ${noun} ${endpoint} refused the connection. Orca's runtime is most likely shutting down; restart Orca.`
    case 'connection_closed':
      return `Connected to ${endpoint}, but the runtime closed the connection before replying. It may be shutting down or at its connection limit; restart Orca.`
    case 'request_timeout':
      return `Connected to ${endpoint}, but the runtime did not reply within ${timeoutMs}ms. It is reachable and not answering, so it is busy or wedged rather than starting.`
    case 'request_rejected':
      return `The runtime at ${endpoint} answered but refused the status request.`
    case 'invalid_response':
      return `The runtime at ${endpoint} returned a response this CLI could not read. The CLI and the Orca app are most likely different versions; reinstall the CLI from this Orca build.`
    case 'unknown':
      return `Could not talk to the Orca runtime at ${endpoint}. The Orca app process is running, so this is not a start still in progress.`
  }
}
