import WebSocket from 'ws'

// Why: without it a blackholed provider host never emits 'error', so audio buffers silently.
export const PROVIDER_HANDSHAKE_TIMEOUT_MS = 10_000
// Why: transcript frames are tiny; the ws default (100 MiB) would let a bad endpoint exhaust memory.
export const PROVIDER_MAX_PAYLOAD_BYTES = 1024 * 1024

/** Opens a provider stream; `ws` (not the global WebSocket) because providers need auth headers. */
export function openProviderWebSocket(
  url: string | URL,
  headers?: Record<string, string>
): WebSocket {
  return new WebSocket(url, {
    handshakeTimeout: PROVIDER_HANDSHAKE_TIMEOUT_MS,
    maxPayload: PROVIDER_MAX_PAYLOAD_BYTES,
    headers
  })
}
