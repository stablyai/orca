export const PUSH_ROUTE_GATEWAY =
  process.env.EXPO_PUBLIC_PUSH_GATEWAY_ORIGIN ?? 'https://push.onorca.dev'
export type RouteHttpResult = { status: number; data?: unknown; invalid?: boolean }
export async function postPushRoute(body: string, signal: AbortSignal): Promise<RouteHttpResult> {
  const abort = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancel = () => {
    abort.abort()
    void reader?.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(cancel, 15_000)
  try {
    if (signal.aborted) {
      cancel()
      return { status: 0 }
    }
    const { fetch: expoFetch } = await import('expo/fetch')
    if (abort.signal.aborted) {
      return { status: 0 }
    }
    const response = await expoFetch(`${PUSH_ROUTE_GATEWAY}/v1/routes`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body,
      signal: abort.signal
    })
    reader = response.body?.getReader()
    const declared = response.headers.get('content-length')
    if (!reader || (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096))) {
      cancel()
      return { status: response.status, invalid: true }
    }
    const bytes = new Uint8Array(4096)
    let size = 0
    while (!abort.signal.aborted) {
      const next = await reader.read()
      if (abort.signal.aborted) {
        return { status: 0 }
      }
      if (next.done) {
        if (!size) {
          return { status: response.status, invalid: true }
        }
        try {
          const data: unknown = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
          )
          return { status: response.status, data }
        } catch {
          return { status: response.status, invalid: true }
        }
      }
      if (next.value.byteLength > bytes.length - size) {
        cancel()
        return { status: response.status, invalid: true }
      }
      bytes.set(next.value, size)
      size += next.value.byteLength
    }
    return { status: 0 }
  } catch {
    return { status: 0 }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    try {
      await reader?.cancel().catch(() => {})
    } finally {
      reader?.releaseLock()
    }
  }
}
