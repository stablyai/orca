import type { BrowserExtensionMainWorldBridge } from '../api/browser-extension-main-world'

type ApiObject = Record<string, unknown>
type ExtensionCallable = (...args: unknown[]) => unknown

/** Resolves Orca documentIds without changing native sendMessage; self-contained for page serialization. */
export function installBrowserExtensionMessageTargets(
  bridge: BrowserExtensionMainWorldBridge,
  firstDiscardedTabId: number
): void {
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : null
  if (!isObject(chromeApi) || !runtime) {
    return
  }
  const scripting = isObject(chromeApi.scripting) ? chromeApi.scripting : null
  const nativeExecuteScript = scripting?.executeScript
  const tabs = isObject(chromeApi.tabs) ? chromeApi.tabs : null
  const nativeSendMessage = tabs?.sendMessage
  const nativeMessages = isObject(runtime.onMessage) ? runtime.onMessage : null
  const probeKey = 'orcaDocumentTargetProbe'

  /** frameId → Orca's documentId for the tab's current documents. */
  const framesOf = async (tabId: unknown): Promise<Map<number, string>> => {
    const frames = new Map<number, string>()
    if (typeof tabId !== 'number') {
      return frames
    }
    const reply = await bridge.call('orcaDocumentTargets', 'frames', [tabId]).catch(() => null)
    if (reply?.ok && Array.isArray(reply.value)) {
      for (const entry of reply.value) {
        if (
          isObject(entry) &&
          typeof entry.frameId === 'number' &&
          typeof entry.documentId === 'string'
        ) {
          frames.set(entry.frameId, entry.documentId)
        }
      }
    }
    return frames
  }
  type Prepared = { args: unknown[]; error?: string }
  /** Chrome's error when `tabId` is a discarded tab; only ids past main's first one can be. */
  const discardedError = async (tabId: unknown, error: string): Promise<string | undefined> => {
    if (typeof tabId !== 'number' || tabId < firstDiscardedTabId) {
      return undefined
    }
    const reply = await bridge.call('tabs', 'get', [tabId, null]).catch(() => null)
    return reply?.ok && isObject(reply.value) && reply.value.discarded === true ? error : undefined
  }
  // Why these words: a discarded tab has no committed document and no frame to receive anything.
  const MESSAGE_ERROR = 'Could not establish connection. Receiving end does not exist.'

  const messageDocument = async (tabId: number, frameId: number): Promise<string> => {
    if (!tabs || !isCallable(nativeSendMessage) || !nativeMessages) {
      throw new Error(MESSAGE_ERROR)
    }
    const add = nativeMessages.addListener
    const remove = nativeMessages.removeListener
    if (!isCallable(add) || !isCallable(remove)) {
      throw new Error(MESSAGE_ERROR)
    }
    const token = crypto.randomUUID()
    let documentId: string | undefined
    const receive = (message: unknown, sender: unknown, respond: unknown): void => {
      const probe = isObject(message) ? message[probeKey] : null
      if (
        isObject(probe) &&
        probe.token === token &&
        probe.response === true &&
        isObject(sender) &&
        sender.id === runtime.id &&
        isObject(sender.tab) &&
        sender.tab.id === tabId &&
        sender.frameId === frameId &&
        typeof sender.documentId === 'string'
      ) {
        documentId = sender.documentId
        if (isCallable(respond)) {
          respond(true)
        }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    add.call(nativeMessages, receive)
    try {
      await Promise.race([
        nativeSendMessage.call(tabs, tabId, { [probeKey]: { token } }, { frameId }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(MESSAGE_ERROR)), 2_500)
        })
      ])
      if (!documentId) {
        throw new Error(MESSAGE_ERROR)
      }
      return documentId
    } finally {
      clearTimeout(timer)
      remove.call(nativeMessages, receive)
    }
  }

  const nativeDocuments = async (
    tabId: number,
    requested: unknown[]
  ): Promise<Map<string, string>> => {
    const frames = await framesOf(tabId)
    const selected = [...frames].filter(([, documentId]) => requested.includes(documentId))
    const resolved = new Map<number, string>()
    if (selected.length > 0 && scripting && isCallable(nativeExecuteScript)) {
      const results: unknown = await Promise.resolve()
        .then(() =>
          nativeExecuteScript.call(scripting, {
            target: { tabId, frameIds: selected.map(([frameId]) => frameId) },
            func: () => undefined
          })
        )
        .catch(() => [])
      for (const result of Array.isArray(results) ? results : []) {
        if (
          isObject(result) &&
          typeof result.frameId === 'number' &&
          typeof result.documentId === 'string'
        ) {
          resolved.set(result.frameId, result.documentId)
        }
      }
    }
    for (const [frameId] of selected) {
      if (!resolved.has(frameId)) {
        resolved.set(frameId, await messageDocument(tabId, frameId))
      }
    }
    const current = selected.length > 0 ? await framesOf(tabId) : frames
    const nativeByOrca = new Map<string, string>()
    for (const [frameId, orcaId] of selected) {
      const nativeId = resolved.get(frameId)
      if (!nativeId || current.get(frameId) !== orcaId) {
        throw new Error(`No matching document with id ${orcaId}`)
      }
      nativeByOrca.set(orcaId, nativeId)
    }
    return nativeByOrca
  }

  const messageTarget = (args: unknown[]): Promise<Prepared> | null => {
    const [tabId, , options] = args
    const documentId = isObject(options) ? options.documentId : undefined
    if (
      typeof tabId !== 'number' ||
      (typeof documentId !== 'string' && tabId < firstDiscardedTabId)
    ) {
      return null
    }
    return (async () => {
      const error = await discardedError(tabId, MESSAGE_ERROR)
      if (error || typeof documentId !== 'string' || !isObject(options)) {
        return { args, error }
      }
      const nativeByOrca = await nativeDocuments(tabId, [documentId])
      return {
        args: [
          tabId,
          args[1],
          { ...options, documentId: nativeByOrca.get(documentId) ?? documentId },
          ...args.slice(3)
        ]
      }
    })()
  }
  const callWithLastError = (message: string, callback: ExtensionCallable): void => {
    const defined = Reflect.defineProperty(runtime, 'lastError', {
      configurable: true,
      value: { message }
    })
    try {
      callback()
    } finally {
      if (defined) {
        delete runtime.lastError
      }
    }
  }

  // Why: `browser` may share chrome's namespace objects; a method is wrapped once.
  const wrapped = new Set<unknown>()
  const wrap = (
    owner: ApiObject,
    name: string,
    retarget: (args: unknown[]) => Promise<Prepared> | null
  ): void => {
    const native = owner[name]
    if (!isCallable(native) || wrapped.has(native)) {
      return
    }
    const replacement = function orcaDocumentTarget(...input: unknown[]): unknown {
      const args = [...input]
      const callback = isCallable(args.at(-1)) ? args.pop() : undefined
      const prepared = retarget(args)
      if (!prepared) {
        return native.apply(owner, input)
      }
      if (isCallable(callback)) {
        void prepared.then(
          ({ args: nativeArgs, error }) => {
            if (error) {
              callWithLastError(error, callback)
              return
            }
            // Why native's own callback: it sets runtime.lastError around it, as Chrome does.
            let calledBack = false
            try {
              native.call(owner, ...nativeArgs, (result: unknown) => {
                calledBack = true
                callback(result)
              })
            } catch (error) {
              if (calledBack) {
                throw error
              }
              callWithLastError(error instanceof Error ? error.message : String(error), callback)
            }
          },
          (error: unknown) =>
            callWithLastError(error instanceof Error ? error.message : String(error), callback)
        )
        return undefined
      }
      return prepared.then(async ({ args: nativeArgs, error }) => {
        if (error) {
          throw new Error(error)
        }
        const result: unknown = await native.apply(owner, nativeArgs)
        return result
      })
    }
    wrapped.add(replacement)
    Reflect.defineProperty(owner, name, {
      value: replacement,
      configurable: true,
      enumerable: true,
      writable: true
    })
  }

  for (const api of new Set([chromeApi, root.browser].filter(isObject))) {
    if (isObject(api.tabs)) {
      wrap(api.tabs, 'sendMessage', messageTarget)
    }
  }
}
