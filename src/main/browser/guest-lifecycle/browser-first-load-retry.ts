/**
 * A page created before its profile's extensions finished loading may have its first request
 * dropped when one loads (Electron drops a request in flight across that). Once `ready` settles, a
 * page whose first load never committed loads once more. First loads here are GETs (a URL or a
 * restored history, which keeps no form data), so a retry never re-sends a form.
 */
export function retryFirstLoadIfStalled(
  contents: Electron.WebContents,
  ready: Promise<unknown>,
  load: () => Promise<void>
): void {
  let committed = false
  const commit = (): void => {
    committed = true
  }
  contents.once('did-navigate', commit)
  void ready.then(() => {
    contents.off('did-navigate', commit)
    if (committed || contents.isDestroyed()) {
      return
    }
    console.warn('[browser] Loading again a page whose first load stalled while extensions loaded')
    void load().catch(() => {})
  })
}
