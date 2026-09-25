/**
 * Which ports the WebSocket listener tries, in order.
 *
 * Why a plan and not a loop in the transport: the ordering carries three separate decisions
 * (STA-1511 fallback-first, issue #8535 pinned-first, and the Tailcat exact-port requirement),
 * and they are easier to read and test as one pure function.
 */
export function planWebSocketBindPorts(options: {
  port: number
  fallbackPort: number | undefined
  preferPinnedPort: boolean
}): { candidates: number[]; persistedFallbackPort: number | undefined } {
  const persistedFallbackPort =
    options.fallbackPort !== undefined &&
    options.fallbackPort !== 0 &&
    options.fallbackPort !== options.port
      ? options.fallbackPort
      : undefined
  const candidates =
    persistedFallbackPort === undefined
      ? [options.port]
      : options.preferPinnedPort
        ? [options.port, persistedFallbackPort]
        : [persistedFallbackPort, options.port]
  return { candidates, persistedFallbackPort }
}

export function describePinnedPortBindFailure(port: number, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Port ${port} is unavailable (${detail}). A Tailcat tunnel needs this exact port; free it or choose another with --port.`
}
