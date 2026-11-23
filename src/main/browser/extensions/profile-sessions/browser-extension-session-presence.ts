/**
 * Once each of these extensions is in the session, or `loadEnded` settles. Loading one that
 * intercepts requests resets the session's URL loader factories, and Electron drops a request in
 * flight across that, so a page's first load must not start before this.
 */
export function whenBrowserExtensionsInSession(
  sess: Electron.Session,
  extensionIds: readonly string[],
  loadEnded: Promise<unknown>
): Promise<void> {
  return Promise.all(extensionIds.map((id) => whenInSession(sess, id, loadEnded))).then(
    () => undefined
  )
}

function whenInSession(
  sess: Electron.Session,
  extensionId: string,
  loadEnded: Promise<unknown>
): Promise<void> {
  if (sess.extensions.getExtension(extensionId)) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const loaded = (_event: Electron.Event, extension: Electron.Extension): void => {
      if (extension.id === extensionId) {
        done()
      }
    }
    const done = (): void => {
      sess.extensions.off('extension-loaded', loaded)
      resolve()
    }
    sess.extensions.on('extension-loaded', loaded)
    void loadEnded.finally(done)
  })
}
