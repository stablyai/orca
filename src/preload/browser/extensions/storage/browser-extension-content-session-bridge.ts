import {
  decodeBrowserExtensionWireJson,
  encodeBrowserExtensionWireJson
} from '../../../../shared/browser/extensions/browser-extension-worker-api'
import type {
  BrowserExtensionMainWorldBridge,
  BrowserExtensionInvokeReply
} from '../api/browser-extension-main-world'

/** Credential stays in the isolated closure; possession grants session storage only. */
export function createBrowserExtensionContentSessionBridge(
  bootstrap: string
): BrowserExtensionMainWorldBridge {
  const nativeFetch = globalThis.fetch.bind(globalThis)
  const context = crypto.randomUUID()
  const handlers: ((namespace: string, event: string, args: unknown[]) => void)[] = []
  let listening = false
  let stream: AbortController | undefined
  const post = (
    route: string,
    metadata: Record<string, unknown>,
    args: unknown = [],
    signal?: AbortSignal
  ): Promise<Response> =>
    nativeFetch(`orca-extension-api://cs/${route}`, {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'text/plain' },
      body: `${JSON.stringify(metadata)}\n${encodeBrowserExtensionWireJson(args)}`,
      signal
    })
  let capability: Promise<string> | undefined
  const token = (): Promise<string> => {
    capability ??= post('mint', { bootstrap }).then(async (response) => {
      if (!response.ok) {
        throw new Error('Extension context was unloaded')
      }
      const result: unknown = decodeBrowserExtensionWireJson(await response.text())
      if (
        !result ||
        typeof result !== 'object' ||
        !('token' in result) ||
        typeof result.token !== 'string'
      ) {
        throw new Error('Extension context was unloaded')
      }
      return result.token
    })
    return capability
  }
  const events = async (controller: AbortController): Promise<void> => {
    try {
      const response = await post(
        'events',
        { token: await token(), context },
        [],
        controller.signal
      )
      if (!response.ok || !response.body || controller.signal.aborted) {
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      for (;;) {
        const next = await reader.read()
        if (next.done || controller.signal.aborted) {
          return
        }
        buffered += decoder.decode(next.value, { stream: true })
        let newline = buffered.indexOf('\n')
        while (newline >= 0) {
          const payload: unknown = decodeBrowserExtensionWireJson(buffered.slice(0, newline))
          buffered = buffered.slice(newline + 1)
          if (
            payload &&
            typeof payload === 'object' &&
            'namespace' in payload &&
            'event' in payload &&
            'args' in payload &&
            payload.namespace === 'orcaStorageSession' &&
            payload.event === 'onChanged' &&
            Array.isArray(payload.args)
          ) {
            for (const handler of handlers) {
              handler(payload.namespace, payload.event, payload.args)
            }
          }
          newline = buffered.indexOf('\n')
        }
      }
    } catch {
      /* Navigation, revocation and last-listener removal end the stream. */
    } finally {
      if (stream === controller) {
        stream = undefined
      }
    }
  }
  const open = (): void => {
    if (!listening || stream) {
      return
    }
    stream = new AbortController()
    void events(stream)
  }
  globalThis.addEventListener(
    'pagehide',
    () => {
      stream?.abort()
      stream = undefined
    },
    { once: true }
  )
  return {
    call: async (_namespace, method, args): Promise<BrowserExtensionInvokeReply> => {
      try {
        const response = await post('call', { token: await token(), context, method }, args)
        if (!response.ok) {
          return {
            ok: false,
            error:
              response.status === 403
                ? 'Access to storage is not allowed from this context.'
                : 'Extension storage call failed'
          }
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The main-owned protocol encodes only BrowserExtensionInvokeReply responses.
        const reply = decodeBrowserExtensionWireJson(
          await response.text()
        ) as BrowserExtensionInvokeReply
        if (reply.ok) {
          open()
        }
        return reply
      } catch {
        return { ok: false, error: 'Extension context was unloaded' }
      }
    },
    listen: (_namespace, _event, active) => {
      listening = active
      if (active) {
        open()
      } else {
        stream?.abort()
        stream = undefined
      }
    },
    onEvent: (handler) => {
      handlers.push(handler)
    },
    passesFilter: () => true
  }
}
