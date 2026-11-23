const heldFirstLoads = new WeakSet<Electron.WebContents>()

/** Its first load is held for its profile's extensions, so it counts as loading already. */
export function isBrowserPageFirstLoadHeld(contents: Electron.WebContents): boolean {
  return heldFirstLoads.has(contents)
}

type HeldLoad = { url: string; options: Electron.LoadURLOptions | undefined }

/**
 * Loads once `ready` settles. Loads asked for meanwhile (the <webview>, extensions, agents all reach
 * `loadURL`) are queued rather than started, so nothing commits ahead of a saved-history restore;
 * `load` gets the newest one, and older ones end as superseded, as Electron's own loads do.
 */
export function loadPageWhenReady(
  contents: Electron.WebContents,
  ready: Promise<unknown>,
  load: (requested: HeldLoad | null) => Promise<void>
): Promise<void> {
  heldFirstLoads.add(contents)
  let requested: (HeldLoad & { settle: (outcome: Promise<void>) => void }) | null = null
  const hold = (url: string, options?: Electron.LoadURLOptions): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      requested?.settle(Promise.reject(supersededLoadError()))
      requested = { url, options, settle: (outcome) => outcome.then(resolve, reject) }
    })
  // Why an instance override: Electron starts a navigation synchronously inside loadURL, with no
  // hook to defer it, and a navigation that commits first makes a history restore impossible.
  Object.defineProperty(contents, 'loadURL', { value: hold, configurable: true, writable: true })
  // A navigation started another way (script, CDP) supersedes the hold, as before it existed.
  let navigatedElsewhere = false
  const navigated = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame && !details.isSameDocument) {
      navigatedElsewhere = true
      requested?.settle(Promise.reject(supersededLoadError()))
      requested = null
    }
  }
  contents.on('did-start-navigation', navigated)
  // One way out: readiness, or the page closing first (which must not wait for readiness).
  let destroyed: () => void = () => {}
  const closed = new Promise<'closed'>((resolve) => {
    destroyed = () => resolve('closed')
    contents.once('destroyed', destroyed)
  })
  return Promise.race([ready.then(() => 'ready' as const), closed]).then((how) => {
    contents.off('destroyed', destroyed)
    contents.off('did-start-navigation', navigated)
    heldFirstLoads.delete(contents)
    Reflect.deleteProperty(contents, 'loadURL')
    const queued = requested
    const outcome = finishHeldLoad()
    queued?.settle(outcome)
    return outcome

    function finishHeldLoad(): Promise<void> {
      if (how === 'closed' || contents.isDestroyed()) {
        return queued
          ? Promise.reject(new Error('The browser page closed while loading'))
          : Promise.resolve()
      }
      if (!navigatedElsewhere) {
        return load(queued ? { url: queued.url, options: queued.options } : null)
      }
      // Saved history can't go back once that navigation may have committed; with nothing queued,
      // that navigation's own load events settle the page.
      return queued ? contents.loadURL(queued.url, queued.options) : new Promise<void>(() => {})
    }
  })
}

function supersededLoadError(): Error {
  return Object.assign(new Error('ERR_ABORTED (-3) loading a held page'), {
    errno: -3,
    code: 'ERR_ABORTED'
  })
}

/**
 * Starts a load queued during the hold. Behind saved history it lands after the back list, as if
 * made after the restore.
 */
export function startHeldLoad(
  contents: Electron.WebContents,
  requested: HeldLoad,
  history: { entries: Electron.NavigationEntry[]; index: number } | null
): Promise<void> {
  const { url, options } = requested
  if (!history) {
    return contents.loadURL(url, options)
  }
  if (Object.values(options ?? {}).some((value) => value !== undefined && value !== '')) {
    // A history entry can't carry load options, so the saved list goes back first.
    const restored = contents.navigationHistory.restore({
      entries: history.entries,
      index: history.index
    })
    return restored.catch(() => {}).then(() => contents.loadURL(url, options))
  }
  const entries = [...history.entries.slice(0, history.index + 1), { url, title: '' }]
  return contents.navigationHistory.restore({ entries, index: entries.length - 1 })
}
