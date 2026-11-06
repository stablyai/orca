/** A paired long poll's keepalive names its request, so a client renews only that request's idle
 *  timer. It has no response id or result, so readers that predate it skip it as a non-response. */
export function startRequestKeepalive(
  requestId: string,
  send: (frame: string) => void,
  intervalMs: number,
  signal: AbortSignal | undefined
): () => void {
  const frame = JSON.stringify({ _keepalive: true, requestId })
  const timer = setInterval(() => send(frame), intervalMs)
  // Keepalive alone must not hold the process open.
  timer.unref?.()
  const stop = (): void => {
    clearInterval(timer)
    signal?.removeEventListener('abort', stop)
  }
  signal?.addEventListener('abort', stop, { once: true })
  if (signal?.aborted) {
    stop()
  }
  return stop
}
