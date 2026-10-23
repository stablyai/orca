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
 * This sends a target naming Orca's ids as the frames they belong to, and gives executeScript
 * results Orca's ids, so one document keeps one id across the calls an extension chains (only for
 * extensions that can learn Orca's ids: webNavigation or webRequest). It also answers calls to a
 * discarded tab, whose id only Orca knows, with Chrome's errors instead of Electron's "No tab".
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installBrowserExtensionDocumentTargets(
  bridge: BrowserExtensionMainWorldBridge,
  firstDiscardedTabId: number
): void {
  const namespace = 'orcaDocumentTargets'
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : null
  if (!isObject(chromeApi) || !runtime) {
    return
  }
  let manifest: unknown = null
  try {
    const getManifest = runtime.getManifest
    manifest = isCallable(getManifest) ? getManifest.call(runtime) : null
  } catch {
    manifest = null
  }
  const declared = isObject(manifest)
    ? [manifest.permissions, manifest.optional_permissions].flatMap((list) =>
        Array.isArray(list) ? list : []
      )
    : []
  const mapsDocuments = declared.includes('webNavigation') || declared.includes('webRequest')

  /** frameId → Orca's documentId for the tab's current documents. */
  const framesOf = async (tabId: unknown): Promise<Map<number, string>> => {
    const frames = new Map<number, string>()
    if (typeof tabId !== 'number') {
      return frames
    }
    const reply = await bridge.call(namespace, 'frames', [tabId]).catch(() => null)
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
  /** The frames of Orca's ids, or null when any id is not Orca's (Chromium's, from a sender). */
  const toFrameIds = (frames: Map<number, string>, documentIds: unknown[]): number[] | null => {
    const byDocument = new Map([...frames].map(([frameId, documentId]) => [documentId, frameId]))
    const frameIds = documentIds.map((id) => (typeof id === 'string' ? byDocument.get(id) : null))
    return frameIds.every((id): id is number => typeof id === 'number') ? frameIds : null
  }
  const withOrcaDocumentIds = (frames: Map<number, string>, results: unknown): unknown =>
    Array.isArray(results)
      ? results.map((result) =>
          isObject(result) && typeof result.frameId === 'number' && frames.has(result.frameId)
            ? { ...result, documentId: frames.get(result.frameId) }
            : result
        )
      : results

  type Prepared = { args: unknown[]; frames: Map<number, string>; error?: string }
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

  /** Null when the call goes to native untouched (and synchronously). */
  const scriptingTarget = (args: unknown[], alwaysAsk: boolean): Promise<Prepared> | null => {
    const injection = isObject(args[0]) ? args[0] : null
    const target = injection && isObject(injection.target) ? injection.target : null
    const documentIds = target && Array.isArray(target.documentIds) ? target.documentIds : null
    const tabId = target?.tabId
    const mapsTarget = mapsDocuments && (documentIds !== null || alwaysAsk)
    if (
      !injection ||
      !target ||
      (!mapsTarget && !(typeof tabId === 'number' && tabId >= firstDiscardedTabId))
    ) {
      return null
    }
    return (async () => {
      const error = await discardedError(tabId, SCRIPT_ERROR)
      const frames = mapsTarget && !error ? await framesOf(tabId) : new Map<number, string>()
      const frameIds = documentIds ? toFrameIds(frames, documentIds) : null
      if (error || !frameIds) {
        return { args, frames, error }
      }
      const rest = Object.fromEntries(
        Object.entries(target).filter(([key]) => key !== 'documentIds')
      )
      return { args: [{ ...injection, target: { ...rest, frameIds } }, ...args.slice(1)], frames }
    })()
  }
  const messageTarget = (args: unknown[]): Promise<Prepared> | null => {
    const [tabId, , options] = args
    const documentId = mapsDocuments && isObject(options) ? options.documentId : undefined
    if (
      typeof documentId !== 'string' &&
      !(typeof tabId === 'number' && tabId >= firstDiscardedTabId)
    ) {
      return null
    }
    return (async () => {
      const error = await discardedError(tabId, MESSAGE_ERROR)
      if (error || typeof documentId !== 'string' || !isObject(options)) {
        return { args, frames: new Map<number, string>(), error }
      }
      const frames = await framesOf(tabId)
      const [frameId] = toFrameIds(frames, [documentId]) ?? []
      if (frameId === undefined) {
        return { args, frames }
      }
      const rest = Object.fromEntries(
        Object.entries(options).filter(([key]) => key !== 'documentId')
      )
      return { args: [tabId, args[1], { ...rest, frameId }, ...args.slice(3)], frames }
    })()
  }
  const callWithLastError = (message: string, callback: ExtensionCallable): void => {
    let defined = false
    try {
      Object.defineProperty(runtime, 'lastError', { configurable: true, get: () => ({ message }) })
      defined = true
    } catch {
      // Native lastError cannot be replaced here; the callback still runs.
    }
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
        void prepared.then(({ args: nativeArgs, frames, error }) => {
          if (error) {
            callWithLastError(error, callback)
            return
          }
          // Why native's own callback: it sets runtime.lastError around it, as Chrome does.
          native.call(owner, ...nativeArgs, (result: unknown) =>
            callback(mapsResults ? withOrcaDocumentIds(frames, result) : result)
          )
        })
        return undefined
      }
      return prepared.then(async ({ args: nativeArgs, frames, error }) => {
        if (error) {
          throw new Error(error)
        }
        const result: unknown = await native.apply(owner, nativeArgs)
        return mapsResults ? withOrcaDocumentIds(frames, result) : result
      })
    }
    wrapped.add(replacement)
    try {
      Object.defineProperty(owner, name, {
        value: replacement,
        configurable: true,
        enumerable: true,
        writable: true
      })
    } catch {
      // Frozen native object: leave it.
    }
  }

  const browserApi = isObject(root.browser) && root.browser !== chromeApi ? root.browser : null
  for (const api of browserApi ? [chromeApi, browserApi] : [chromeApi]) {
    if (isObject(api.scripting)) {
      wrap(api.scripting, 'executeScript', (args) => scriptingTarget(args, true), true)
      wrap(api.scripting, 'insertCSS', (args) => scriptingTarget(args, false), false)
      wrap(api.scripting, 'removeCSS', (args) => scriptingTarget(args, false), false)
    }
    if (isObject(api.tabs)) {
      wrap(api.tabs, 'sendMessage', messageTarget, false)
    }
  }
}
