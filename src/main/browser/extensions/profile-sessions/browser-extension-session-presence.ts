const startingBySession = new WeakMap<Electron.Session, readonly string[]>()
const loadEndedListeners = new WeakMap<Electron.Session, Set<(extensionId: string) => void>>()

/** A load into this session failed: that extension will not appear, so nothing waits for it. */
export function noteBrowserExtensionLoadFailed(sess: Electron.Session, extensionId: string): void {
  const starting = startingBySession.get(sess)
  if (starting) {
    startingBySession.set(
      sess,
      starting.filter((id) => id !== extensionId)
    )
  }
  loadEndedListeners.get(sess)?.forEach((listener) => listener(extensionId))
}

/** A profile session's attach: the extensions it starts. */
export function noteBrowserExtensionsStarting(
  sess: Electron.Session,
  extensionIds: readonly string[]
): void {
  startingBySession.set(sess, extensionIds)
}

/**
 * Once each extension the session's last attach started is in it, or `loadEnded` settles. Loading one that
 * intercepts requests resets the session's URL loader factories, and Electron drops a request in
 * flight across that, so a page's first load must not start before this.
 */
export function whenBrowserExtensionsInSession(
  sess: Electron.Session,
  loadEnded: Promise<unknown>
): Promise<void> {
  const missing = new Set(
    (startingBySession.get(sess) ?? []).filter((id) => !sess.extensions.getExtension(id))
  )
  if (missing.size === 0) {
    return Promise.resolve()
  }
  // One listener for all of them, so each load event costs one lookup, not one per extension.
  return new Promise<void>((resolve) => {
    const ended = (extensionId: string): void => {
      missing.delete(extensionId)
      if (missing.size === 0) {
        done()
      }
    }
    const loaded = (_event: Electron.Event, extension: Electron.Extension): void =>
      ended(extension.id)
    let failures = loadEndedListeners.get(sess)
    if (!failures) {
      failures = new Set()
      loadEndedListeners.set(sess, failures)
    }
    failures.add(ended)
    const done = (): void => {
      sess.extensions.off('extension-loaded', loaded)
      failures.delete(ended)
      resolve()
    }
    sess.extensions.on('extension-loaded', loaded)
    void loadEnded.finally(done)
  })
}
