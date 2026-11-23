const transportCodes = [
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ETIMEDOUT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
] as const
const knownCodes = new Set<string>(transportCodes)
const maxErrorNodes = 16

function ownValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

/** Only fixed labels cross the log boundary, never raw fetch errors or endpoint data. */
export function describePushGatewayTransportFailure(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted && error === signal.reason) {
    return 'request_deadline'
  }
  const pending = [error]
  const seen = new Set<object>()
  const codes = new Set<string>()
  try {
    for (let i = 0; i < pending.length; i++) {
      const value = pending[i]
      if (!value || typeof value !== 'object' || seen.has(value)) {
        continue
      }
      seen.add(value)
      const code = ownValue(value, 'code')
      if (typeof code === 'string' && knownCodes.has(code)) {
        codes.add(code)
      }
      const cause = ownValue(value, 'cause')
      if (cause !== undefined && pending.length < maxErrorNodes) {
        pending.push(cause)
      }
      const errors = ownValue(value, 'errors')
      if (Array.isArray(errors)) {
        const length = ownValue(errors, 'length')
        if (typeof length === 'number') {
          for (let j = 0; j < length && pending.length < maxErrorNodes; j++) {
            pending.push(ownValue(errors, String(j)))
          }
        }
      }
    }
  } catch {
    // Failure diagnostics are best-effort, including for unusual thrown values.
  }
  return transportCodes.filter((code) => codes.has(code)).join(', ') || 'unknown_network_error'
}
