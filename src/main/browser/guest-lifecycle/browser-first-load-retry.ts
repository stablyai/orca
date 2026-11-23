type Retry = { contents: Electron.WebContents; load: () => Promise<void>; dispose: () => void }
// One reaction per readiness promise; a page leaves its set when it commits, stops, navigates
// elsewhere or closes, so only live pages are kept while extension startup runs on.
const retriesByReady = new WeakMap<Promise<unknown>, Set<Retry>>()

/**
 * A page created before its profile's extensions finished loading may have its first request
 * dropped when one loads (Electron drops a request in flight across that). Once `ready` settles, a
 * page whose first load neither committed nor stopped, and that nothing navigated since, loads once
 * more. First loads here are GETs (a URL or a restored history, which keeps no form data), so a
 * retry never re-sends a form. `ownNavigations`: how many navigations `load` itself starts.
 */
export function retryFirstLoadIfStalled(
  contents: Electron.WebContents,
  ready: Promise<unknown>,
  load: () => Promise<void>,
  ownNavigations = 1
): void {
  let retries = retriesByReady.get(ready)
  if (!retries) {
    const pending = new Set<Retry>()
    retries = pending
    retriesByReady.set(ready, pending)
    void ready.then(() => {
      for (const retry of pending) {
        retry.dispose()
        console.warn(
          '[browser] Loading again a page whose first load stalled while extensions loaded'
        )
        void retry.load().catch(() => {})
      }
    })
  }
  const set = retries
  let started = 0
  const cancel = (): void => retry.dispose()
  const navigationStarted = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame && !details.isSameDocument && ++started > ownNavigations) {
      cancel()
    }
  }
  // Before its own load starts, the empty guest's own stop events mean nothing.
  const stopped = (): void => {
    if (started > 0) {
      cancel()
    }
  }
  const retry: Retry = {
    contents,
    load,
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
