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
  let pageActive = true
  let retired = false
  let recoveryAvailable = true
  let recovery: ReturnType<typeof setTimeout> | undefined
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
        retired = response.status === 403
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
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let interrupted = false
    try {
      const response = await post(
        'events',
        { token: await token(), context },
        [],
        controller.signal
      )
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {})
        return
      }
      if (response.status === 403) {
        retired = true
        return
      }
      if (!response.ok || !response.body) {
        interrupted = true
        return
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let fragments: string[] = []
      for (;;) {
        const next = await reader.read()
        if (controller.signal.aborted) {
          return
        }
        if (next.done) {
          interrupted = true
          return
        }
        const chunk = decoder.decode(next.value, { stream: true })
        let cursor = 0
        let newline = chunk.indexOf('\n', cursor)
        while (newline >= 0) {
          fragments.push(chunk.slice(cursor, newline))
          const payload: unknown = decodeBrowserExtensionWireJson(fragments.join(''))
          fragments = []
          cursor = newline + 1
          if (payload && typeof payload === 'object' && 'control' in payload) {
            retired = payload.control === 'retired'
            interrupted = !retired
            return
          }
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
            recoveryAvailable = true
            for (const handler of handlers) {
              try {
                handler(payload.namespace, payload.event, payload.args)
              } catch (error) {
                console.error('Extension storage change listener failed', error)
              }
            }
          }
          newline = chunk.indexOf('\n', cursor)
        }
        if (cursor < chunk.length) {
          fragments.push(chunk.slice(cursor))
        }
      }
    } catch {
      interrupted = true
    } finally {
      void reader?.cancel().catch(() => {})
      if (stream === controller) {
        stream = undefined
        if (interrupted && !controller.signal.aborted && !retired && listening && pageActive) {
          console.warn('Extension storage change connection failed; changes may have been missed.')
          if (recoveryAvailable) {
            recoveryAvailable = false
            recovery = setTimeout(() => {
              recovery = undefined
              open()
            }, 0)
          }
        }
      }
    }
  }
  const open = (): void => {
    if (!listening || !pageActive || retired || stream || recovery !== undefined) {
      return
    }
    stream = new AbortController()
    void events(stream)
  }
  const stop = (): void => {
    clearTimeout(recovery)
    recovery = undefined
    stream?.abort()
    stream = undefined
  }
  globalThis.addEventListener('pagehide', () => {
    pageActive = false
    stop()
  })
  globalThis.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      pageActive = true
      recoveryAvailable = true
      open()
    }
  })
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
          recoveryAvailable = true
          open()
        }
        return reply
      } catch {
        return { ok: false, error: 'Extension context was unloaded' }
      }
    },
    listen: (_namespace, _event, active) => {
      const changed = listening !== active
      listening = active
      if (active) {
        if (changed) {
          recoveryAvailable = true
        }
        open()
      } else {
        stop()
      }
    },
    onEvent: (handler) => {
      handlers.push(handler)
    },
    passesFilter: () => true
  }
}
