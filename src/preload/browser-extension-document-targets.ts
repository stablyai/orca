import type { BrowserExtensionMainWorldBridge } from './browser-extension-main-world'

/** Main-only namespace listing a tab's frames with Orca's documentIds; never on `chrome`. */
export const PRELOAD_DOCUMENT_TARGETS_NAMESPACE = 'orcaDocumentTargets'

type ApiObject = Record<string, unknown>
type ExtensionCallable = (...args: unknown[]) => unknown

/** Main's first synthetic tab id (FIRST_DISCARDED_BROWSER_TAB_ID); a test pins the two together. */
export const PRELOAD_FIRST_DISCARDED_TAB_ID = 1_000_000_000

/**
 * Orca names documents itself in webNavigation and webRequest (Electron gives main no Chromium
 * document id), but Electron's native scripting and tabs.sendMessage resolve only Chromium's ids.
 * Side-effect-free probes resolve Orca's ids to native document ids before dispatch. Only proven
 * document pairs name executeScript results. It also answers calls to a
 * discarded tab, whose id only Orca knows, with Chrome's errors instead of Electron's "No tab".
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installBrowserExtensionDocumentTargets(
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
  const withOrcaDocumentIds = (documents: Map<string, string>, results: unknown): unknown =>
    Array.isArray(results)
      ? results.map((result) =>
          isObject(result) &&
          typeof result.documentId === 'string' &&
          documents.has(result.documentId)
            ? { ...result, documentId: documents.get(result.documentId) }
            : result
        )
      : results

  type Prepared = { args: unknown[]; documents: Map<string, string>; error?: string }
  /** Chrome's error when `tabId` is a discarded tab; only ids past main's first one can be. */
  const discardedError = async (tabId: unknown, error: string): Promise<string | undefined> => {
    if (typeof tabId !== 'number' || tabId < firstDiscardedTabId) {
      return undefined
    }
    const reply = await bridge.call('tabs', 'get', [tabId, null]).catch(() => null)
    return reply?.ok && isObject(reply.value) && reply.value.discarded === true ? error : undefined
  }
  // Why these words: a discarded tab has no committed document and no frame to receive anything.
  const SCRIPT_ERROR =
    'Cannot access contents of url "". Extension manifest must request permission to access this host.'
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
    requested: unknown[],
    messaging: boolean
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
        .catch((error: unknown) => {
          if (!messaging) {
            throw error
          }
          return []
        })
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
    if (messaging) {
      for (const [frameId] of selected) {
        if (!resolved.has(frameId)) {
          resolved.set(frameId, await messageDocument(tabId, frameId))
        }
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

  /** Null when the call goes to native untouched (and synchronously). */
  const scriptingTarget = (args: unknown[]): Promise<Prepared> | null => {
    const injection = isObject(args[0]) ? args[0] : null
    const target = injection && isObject(injection.target) ? injection.target : null
    const documentIds = target && Array.isArray(target.documentIds) ? target.documentIds : null
    const tabId = target?.tabId
    if (
      !injection ||
      !target ||
      typeof tabId !== 'number' ||
      (!documentIds && tabId < firstDiscardedTabId)
    ) {
      return null
    }
    return (async () => {
      const error = await discardedError(tabId, SCRIPT_ERROR)
      if (error || !documentIds) {
        return { args, documents: new Map(), error }
      }
      const nativeByOrca = await nativeDocuments(tabId, documentIds, false)
      const nativeIds = documentIds.map((id) =>
        typeof id === 'string' ? (nativeByOrca.get(id) ?? id) : id
      )
      return {
        args: [{ ...injection, target: { ...target, documentIds: nativeIds } }, ...args.slice(1)],
        documents: new Map([...nativeByOrca].map(([orcaId, nativeId]) => [nativeId, orcaId]))
      }
    })()
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
        return { args, documents: new Map(), error }
      }
      const nativeByOrca = await nativeDocuments(tabId, [documentId], true)
      return {
        args: [
          tabId,
          args[1],
          { ...options, documentId: nativeByOrca.get(documentId) ?? documentId },
          ...args.slice(3)
        ],
        documents: new Map()
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
    retarget: (args: unknown[]) => Promise<Prepared> | null,
    mapsResults: boolean
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
          ({ args: nativeArgs, documents, error }) => {
            if (error) {
              callWithLastError(error, callback)
              return
            }
            // Why native's own callback: it sets runtime.lastError around it, as Chrome does.
            let calledBack = false
            try {
              native.call(owner, ...nativeArgs, (result: unknown) => {
                calledBack = true
                callback(mapsResults ? withOrcaDocumentIds(documents, result) : result)
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
      return prepared.then(async ({ args: nativeArgs, documents, error }) => {
        if (error) {
          throw new Error(error)
        }
        const result: unknown = await native.apply(owner, nativeArgs)
        return mapsResults ? withOrcaDocumentIds(documents, result) : result
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
    if (isObject(api.scripting)) {
      wrap(api.scripting, 'executeScript', scriptingTarget, true)
      wrap(api.scripting, 'insertCSS', scriptingTarget, false)
      wrap(api.scripting, 'removeCSS', scriptingTarget, false)
    }
    if (isObject(api.tabs)) {
      wrap(api.tabs, 'sendMessage', messageTarget, false)
    }
  }
}
