import type { VoiceControlErrorKind } from '../../shared/voice-control-types'

/**
 * Every OpenAI-facing failure in the voice control funnels here so the renderer can offer
 * a remedy instead of a raw message. `tls-intercept` is the corporate-proxy signature
 * (e.g. Zscaler SSL inspection): the OS trust store accepts the middlebox cert but Node's
 * bundled CAs reject it, surfacing as a bare "fetch failed" with a cert code underneath.
 */

const TLS_INTERCEPT_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_CHAIN_TOO_LONG',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_COMMON_NAME_INVALID',
  'ERR_CERT_DATE_INVALID'
])

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET'
])

function collectCodes(error: unknown, codes: Set<string>, depth: number): void {
  if (depth > 4 || !(error instanceof Error)) {
    return
  }
  const code = 'code' in error ? error.code : undefined
  if (typeof code === 'string') {
    codes.add(code)
  }
  collectCodes(error.cause, codes, depth + 1)
}

export function classifyOpenAiFetchError(error: unknown): VoiceControlErrorKind {
  const codes = new Set<string>()
  collectCodes(error, codes, 0)
  for (const code of codes) {
    if (TLS_INTERCEPT_CODES.has(code)) {
      return 'tls-intercept'
    }
  }
  for (const code of codes) {
    if (NETWORK_CODES.has(code)) {
      return 'network'
    }
  }
  return 'unknown'
}

export function classifyOpenAiHttpStatus(status: number): VoiceControlErrorKind {
  if (status === 401 || status === 403) {
    return 'auth'
  }
  if (status === 429) {
    return 'quota'
  }
  if (status >= 500) {
    return 'unavailable'
  }
  return 'unknown'
}
