export type BrowserExtensionInertApiContext = 'page' | 'worker' | 'content-script'

type ApiObject = Record<string, unknown>
type ExtensionCallable = (...args: unknown[]) => unknown

/**
 * Chrome APIs whose answer in Orca is fixed: no enterprise policy, incognito, omnibox or font
 * settings. Extensions touch them at startup, so each gets Chrome's shape and an empty or no-op
 * result here, with no round trip to main. Existing members win, except storage.managed, whose
 * Electron version fails ("not available") where Chrome answers {} without a policy.
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installBrowserExtensionInertApis(context: BrowserExtensionInertApiContext): void {
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  if (!isObject(chromeApi)) {
    return
  }
  const apis =
    isObject(root.browser) && root.browser !== chromeApi ? [chromeApi, root.browser] : [chromeApi]
  const readManifest = (): ApiObject => {
    try {
      const runtime = chromeApi.runtime
      const getManifest = isObject(runtime) ? runtime.getManifest : null
      const manifest: unknown = isCallable(getManifest) ? getManifest.call(runtime) : null
      return isObject(manifest) ? manifest : {}
    } catch {
      return {}
    }
  }
  const manifest = readManifest()
  const permissions = [manifest.permissions, manifest.optional_permissions].flatMap((list) =>
    Array.isArray(list) ? list : []
  )
  const define = (target: ApiObject, key: string, value: unknown): void => {
    try {
      Object.defineProperty(target, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true
      })
    } catch {
      // Frozen native object: leave it.
    }
  }
  /** Chrome style: a trailing callback gets the result later; otherwise a promise. */
  const answer =
    (result: () => unknown) =>
    (...args: unknown[]): unknown => {
      const last = args.findLast((arg) => arg !== undefined)
      if (isCallable(last)) {
        void Promise.resolve().then(() => last(result()))
        return undefined
      }
      return Promise.resolve(result())
    }
  const inertEvent = (): ApiObject => {
    const listeners = new Set<unknown>()
    return {
      addListener: (callback: unknown) => {
        listeners.add(callback)
      },
      removeListener: (callback: unknown) => {
        listeners.delete(callback)
      },
      hasListener: (callback: unknown) => listeners.has(callback),
      hasListeners: () => listeners.size > 0
    }
  }
  /** Adds members to `namespace` on chrome and browser; `existingOnly` never creates it. */
  const install = (
    namespace: string,
    members: ApiObject,
    options: { replace?: string[]; existingOnly?: boolean } = {}
  ): void => {
    for (const api of apis) {
      let target: unknown = api
      for (const key of namespace.split('.')) {
        const parent: ApiObject = isObject(target) ? target : {}
        let next = parent[key]
        if (!isObject(next) && !options.existingOnly) {
          next = {}
          define(parent, key, next)
        }
        target = next
      }
      if (!isObject(target)) {
        continue
      }
      for (const [key, value] of Object.entries(members)) {
        if (!(key in target) || options.replace?.includes(key)) {
          define(target, key, value)
        }
      }
    }
  }

  // Chrome without an enterprise policy: an empty, read-only area.
  install(
    'storage.managed',
    {
      get: answer(() => ({})),
      getKeys: answer(() => []),
      getBytesInUse: answer(() => 0),
      onChanged: inertEvent()
    },
    { replace: ['get', 'getKeys', 'getBytesInUse'], existingOnly: true }
  )
  if (context !== 'worker') {
    // Why open roots only: an isolated world cannot see a closed root the page attached.
    install('dom', {
      openOrClosedShadowRoot: (element: unknown) =>
        isObject(element) && isObject(element.shadowRoot) ? element.shadowRoot : null
    })
  }
  if (context === 'content-script') {
    install('extension', { inIncognitoContext: false })
    return
  }
  if (context === 'page') {
    // Why []: Orca cannot hand one extension page another's window; Chrome has none in workers.
    install('extension', { getViews: () => [] })
  }
  install('runtime', { onPerformanceWarning: inertEvent() })
  install('permissions', {
    addHostAccessRequest: answer(() => undefined),
    removeHostAccessRequest: answer(() => undefined)
  })
  if ('omnibox' in manifest) {
    install('omnibox', {
      setDefaultSuggestion: answer(() => undefined),
      onInputStarted: inertEvent(),
      onInputChanged: inertEvent(),
      onInputEntered: inertEvent(),
      onInputCancelled: inertEvent(),
      onDeleteSuggestion: inertEvent(),
      OnInputEnteredDisposition: {
        CURRENT_TAB: 'currentTab',
        NEW_FOREGROUND_TAB: 'newForegroundTab',
        NEW_BACKGROUND_TAB: 'newBackgroundTab'
      }
    })
  }
  if (permissions.includes('fontSettings')) {
    // Why generic families: listing installed fonts needs a user gesture (queryLocalFonts).
    const generic = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']
    install('fontSettings', {
      getFontList: answer(() => generic.map((fontId) => ({ fontId, displayName: fontId }))),
      getFont: answer(() => ({ fontId: '', levelOfControl: 'not_controllable' })),
      setFont: answer(() => undefined),
      clearFont: answer(() => undefined),
      onFontChanged: inertEvent()
    })
  }
}
