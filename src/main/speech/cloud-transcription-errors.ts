/**
 * Why: providers echo credentials back in their error bodies (OpenAI repeats `sk-...`,
 * ElevenLabs names `xi-api-key`), and every cloud error ends up in a toast. One redactor per
 * repo keeps the guarantee provider-independent, and the network helper preserves the undici
 * cause code so `Speech error: fetch failed` becomes a diagnosable DNS/TLS/proxy failure.
 */
export function redactTranscriptionSecrets(message: string): string {
  return message
    .replace(/\bsk[_-][A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bxi-api-key\s*[:=]\s*\S+/gi, 'xi-api-key [redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .trim()
}

export function describeCloudTranscriptionNetworkFailure(
  error: unknown,
  providerLabel: string
): string {
  // Why: undici hangs the transport failure (DNS, TLS, proxy) off `cause`, which the DOM lib
  // does not type; read it with `in` narrowing instead of asserting a shape.
  let cause: unknown
  if (error !== null && typeof error === 'object' && 'cause' in error) {
    cause = error.cause
  }

  let detail: string
  if (cause !== null && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
    detail = cause.code
  } else if (
    cause !== null &&
    typeof cause === 'object' &&
    'message' in cause &&
    typeof cause.message === 'string'
  ) {
    detail = cause.message
  } else if (error instanceof Error) {
    detail = error.message
  } else {
    detail = String(error)
  }

  return `${providerLabel} transcription request failed: ${detail}`
}
