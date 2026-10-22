import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

// Why: app-server wraps reqwest's transport-error Display text ("error sending request for url
// (...)" when the proxy/DNS/TCP/TLS hop fails); HTTP status failures never use these phrases.
const CODEX_TRANSPORT_FAILURE_PATTERN =
  /\berror sending request\b|\brequest or response body error\b/i

export function classifyCodexRpcErrorFailureKind(
  message: string
): UsageRateLimitFailureKind | undefined {
  return CODEX_TRANSPORT_FAILURE_PATTERN.test(message) ? 'network' : undefined
}
