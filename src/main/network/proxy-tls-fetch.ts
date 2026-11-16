import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import nodeFetch, { type BodyInit as NodeBody } from 'node-fetch'
import { ProxyAgent } from 'proxy-agent'
import type { ProxySession } from './electron-default-proxy-session'
import { awaitProxySessionApplication } from './proxy-settings'
import { resolveSessionProxy } from './proxy-route'
import { trackProxySessionConnection } from './proxy-session-connections'
import { getProxySessionTlsSettings, type ProxyTlsSettings } from './proxy-tls-settings'

/** Use Node's TLS verifier only when the app needs additional trust or an explicit bypass. */
export async function fetchWithProxyTls(
  session: ProxySession,
  tls: ProxyTlsSettings,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController()
  const signal = init?.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal
  const agent = new ProxyAgent({
    ...tls.options,
    getProxyForUrl: async (target) => {
      if (
        !(await awaitProxySessionApplication(session)) ||
        getProxySessionTlsSettings(session) !== tls
      ) {
        throw new Error('Proxy settings changed or are not ready')
      }
      signal.throwIfAborted()
      const proxy = await resolveSessionProxy(session, target)
      signal.throwIfAborted()
      return proxy
    }
  })
  const untrack = trackProxySessionConnection(session, () => controller.abort())
  const cleanup = (): void => {
    untrack()
    agent.destroy()
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node-fetch accepts standard BodyInit values except Web Streams, which are adapted below.
    let requestBody = init?.body as NodeBody | null | undefined
    if (init?.body instanceof ReadableStream) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node and DOM declare the same Web Stream with incompatible BYOB generics.
      requestBody = Readable.fromWeb(init.body as NodeReadableStream)
    }
    const response = await nodeFetch(url, {
      ...init,
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: requestBody,
      signal,
      agent
    })
    const body = response.body instanceof Readable ? response.body : null
    body?.once('close', cleanup)
    if (!body) {
      cleanup()
    }
    const bodyless =
      init?.method?.toUpperCase() === 'HEAD' || [204, 205, 304].includes(response.status)
    if (bodyless) {
      body?.destroy()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: toWeb returns a native Web Stream; only the Node/DOM BYOB declarations differ.
    const webBody = body && !bodyless ? (Readable.toWeb(body) as ReadableStream) : null
    const result = new Response(webBody, {
      status: response.status,
      statusText: response.statusText,
      headers: Array.from(response.headers)
    })
    return withResponseLocation(result, response)
  } catch (error) {
    cleanup()
    throw error
  }
}

function withResponseLocation(
  result: Response,
  source: Pick<Response, 'url' | 'redirected'>
): Response {
  const clone = result.clone.bind(result)
  Object.defineProperties(result, {
    url: { value: source.url },
    redirected: { value: source.redirected },
    clone: { value: () => withResponseLocation(clone(), source) }
  })
  return result
}
