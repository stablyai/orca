// Synthetic liveness probe for the alerts Worker: an unauthenticated control upgrade must be
// refused 401 by the edge's router, which proves the Worker is up, routing and verifying tokens
// without touching any object or database. Stateless, like the rules: one failed run alerts (with
// the status), and every later failing run alerts again until the edge answers.
// probeObject goes one step deeper: GET /__health/object makes the edge call a canary HostRelay
// object that reads its own storage, so a broken object runtime (or storage) alerts too.

export const PROBE_TIMEOUT_MS = 5_000

// null when the edge answered 401 in time; otherwise what went wrong.
export async function probeEdge(baseUrl: string, now: () => number = Date.now): Promise<string | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/host/control`
  const started = now()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new DOMException('probe timed out', 'TimeoutError')), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      },
      signal: abort.signal
    })
    const elapsed = now() - started
    // Never keep a socket the edge unexpectedly accepted.
    const socket = (response as Response & { webSocket?: WebSocket | null }).webSocket
    if (socket) {
      socket.accept()
      socket.close(1000, 'probe')
    }
    if (response.status !== 401) { return `unauthenticated control upgrade got ${response.status}, expected 401` }
    if (elapsed > PROBE_TIMEOUT_MS) { return `unauthenticated control upgrade took ${elapsed} ms` }
    return null
  } catch (error) {
    const name = (error as Error).name
    return name === 'TimeoutError' || name === 'AbortError'
      ? `unauthenticated control upgrade timed out after ${PROBE_TIMEOUT_MS} ms`
      : `unauthenticated control upgrade failed: ${(error as Error).message}`
  } finally {
    clearTimeout(timer)
  }
}

// Slower than this (or not {ok:true} with 200) alerts as 'object-probe'.
export const OBJECT_PROBE_SLOW_MS = 2_000

// null when the canary object answered 200 {ok:true} within OBJECT_PROBE_SLOW_MS.
export async function probeObject(baseUrl: string, now: () => number = Date.now): Promise<string | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/__health/object`
  const started = now()
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new DOMException('probe timed out', 'TimeoutError')), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: abort.signal })
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null
    const elapsed = now() - started
    if (response.status !== 200 || body?.ok !== true) { return `object health check got ${response.status}, expected 200` }
    if (elapsed > OBJECT_PROBE_SLOW_MS) { return `object health check took ${elapsed} ms` }
    return null
  } catch (error) {
    const name = (error as Error).name
    return name === 'TimeoutError' || name === 'AbortError'
      ? `object health check timed out after ${PROBE_TIMEOUT_MS} ms`
      : `object health check failed: ${(error as Error).message}`
  } finally {
    clearTimeout(timer)
  }
}
