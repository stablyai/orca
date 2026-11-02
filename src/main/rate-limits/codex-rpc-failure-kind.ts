import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'

// reqwest wraps proxy/DNS/TCP/TLS failures in these phrases; HTTP-status failures use different text.
const CODEX_TRANSPORT_FAILURE_PATTERN =
  /\berror sending request\b|\brequest or response body error\b/i

export function classifyCodexRpcErrorFailureKind(
  message: string
): UsageRateLimitFailureKind | undefined {
  return CODEX_TRANSPORT_FAILURE_PATTERN.test(message) ? 'network' : undefined
}
