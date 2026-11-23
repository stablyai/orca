type Retry = {
  load: () => Promise<void>
  /** Its first request was in flight when Electron dropped requests in flight, see resetsRequests. */
  disrupted: boolean
  started: boolean
  dispose: () => void
}
// One reaction per readiness promise; a page leaves its set when it commits, stops, navigates
// elsewhere or closes, so only live pages are kept while extension startup runs on.
const retriesByReady = new WeakMap<Promise<unknown>, Set<Retry>>()

// Chromium's WebRequestAPI resets a session's URL loader factories, dropping requests in flight,
// only when its first extension with one of these permissions loads.
const REQUEST_PROXY_PERMISSIONS = new Set([
  'webRequest',
  'webRequestBlocking',
  'declarativeWebRequest',
  'declarativeNetRequest',
  'declarativeNetRequestWithHostAccess',
  'webview'
])

function proxiesRequests(extension: Electron.Extension): boolean {
  const permissions: unknown = extension.manifest?.permissions
  return (
    Array.isArray(permissions) &&
    permissions.some((p) => typeof p === 'string' && REQUEST_PROXY_PERMISSIONS.has(p))
  )
}

function resetsRequests(extensions: Electron.Extensions, loaded: Electron.Extension): boolean {
  return (
    proxiesRequests(loaded) &&
    !extensions.getAllExtensions().some((e) => e.id !== loaded.id && proxiesRequests(e))
  )
}

/**
 * A page created before its profile's extensions finished loading may have its first request
 * dropped when one loads (Electron drops a request in flight across that). Once `ready` settles, a
 * page whose first load was in flight when that happened, and that neither committed nor
 * stopped nor was navigated elsewhere since, loads once more. Callers pass only loads that are
 * re-loads anyway (a restored tab or history), never a fresh address.
 */
export function retryFirstLoadIfStalled(
  contents: Electron.WebContents,
  ready: Promise<unknown>,
  load: () => Promise<void>
): void {
  let retries = retriesByReady.get(ready)
  if (!retries) {
    const pending = new Set<Retry>()
    retries = pending
    retriesByReady.set(ready, pending)
    const extensions = contents.session.extensions
    const extensionLoaded = (_event: Electron.Event, loaded: Electron.Extension): void => {
      if (!resetsRequests(extensions, loaded)) {
        return
      }
      for (const retry of pending) {
        retry.disrupted ||= retry.started
      }
    }
    extensions.on('extension-loaded', extensionLoaded)
    void ready.then(() => {
      extensions.off('extension-loaded', extensionLoaded)
      for (const retry of pending) {
        retry.dispose()
        if (retry.disrupted) {
          console.warn(
            '[browser] Loading again a page whose first load stalled while extensions loaded'
          )
          void retry.load().catch(() => {})
        }
      }
    })
  }
  const set = retries
  const cancel = (): void => retry.dispose()
  const navigationStarted = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (!details.isMainFrame || details.isSameDocument) {
      return
    }
    // The first is its own load; any later one supersedes it.
    if (retry.started) {
      cancel()
    }
    retry.started = true
  }
  // Before its own load starts, the empty guest's own stop events mean nothing.
  const stopped = (): void => {
    if (retry.started) {
      cancel()
    }
  }
  const retry: Retry = {
    load,
    disrupted: false,
    started: false,
    dispose: () => {
      set.delete(retry)
      contents.off('did-start-navigation', navigationStarted)
      contents.off('did-navigate', cancel)
      contents.off('did-stop-loading', stopped)
      contents.off('destroyed', cancel)
    }
  }
  set.add(retry)
  contents.on('did-start-navigation', navigationStarted)
  contents.on('did-navigate', cancel)
  contents.on('did-stop-loading', stopped)
  contents.once('destroyed', cancel)
}
