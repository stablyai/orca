import { app } from 'electron'
import { getBrowserExtensionProfileIdForSession } from '../api-runtime/browser-extension-api-host'
import {
  getBrowserExtensionSessionForProfile,
  getBrowserExtensionProfileLoadingPhase,
  whenBrowserExtensionProfileLoaded,
  whenBrowserExtensionProfileUnloaded
} from './browser-extension-session-loader'
import { whenBrowserExtensionsInSession } from './browser-extension-session-presence'

// Why bounded: slow restore hooks must not keep the page from loading.
const FIRST_LOAD_WAIT_MS = 3_000
// Why this bound: inside the 8 s tab registration and 15 s recovery deadlines that wrap a page's
// creation; a page opened at it whose first load stalls loads once more when they are ready.
const IN_SESSION_WAIT_LIMIT_MS = 5_000

/**
 * What a page opening in this profile must wait for before its first load, or null when its
 * extensions are not loading. Waiting registers content scripts before the page commits, and
 * keeps its request out of flight while a webRequest extension loads, which Electron would
 * leave hanging. Callers start the profile's extensions first (registry.attachExtensions).
 */
export function whenBrowserExtensionsStartFor(profileId: string): Promise<void> | null {
  return whileExtensionsStart(profileId)
}

/**
 * For a load into an existing page: the same wait, when its profile's extensions are still
 * starting. It ends early if the page closes, so callers must check it is still open.
 */
export function whenBrowserExtensionsReadyForPage(
  contents: Electron.WebContents
): Promise<void> | null {
  const profileId = getBrowserExtensionProfileIdForSession(contents.session)
  const wait = profileId ? whileExtensionsStart(profileId) : null
  return wait && untilClosed(contents, wait)
}

function untilClosed(contents: Electron.WebContents, wait: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      contents.off('destroyed', done)
      resolve()
    }
    contents.once('destroyed', done)
    void wait.then(done)
  })
}

type StartWait = { phase: object; wait: Promise<void>; inSession: Promise<void>; late: boolean }
const startWaits = new Map<string, StartWait>()

/**
 * While this profile's wait has given up at its bound and its extensions are still not all in the
 * session: settles once they are, for a page opened meanwhile to retry a first load that stalled.
 * Null otherwise, so a page opened after they arrived never retries.
 */
export function whenLateBrowserExtensionsReadyForPage(
  contents: Electron.WebContents
): Promise<void> | null {
  const profileId = getBrowserExtensionProfileIdForSession(contents.session)
  const running = profileId ? startWaits.get(profileId) : undefined
  return running?.late ? running.inSession : null
}

// One bounded wait per profile attach, so a later caller never extends the deadline.
function whileExtensionsStart(profileId: string): Promise<void> | null {
  const phase = getBrowserExtensionProfileLoadingPhase(profileId)
  if (!phase) {
    return null
  }
  const running = startWaits.get(profileId)
  if (running?.phase === phase) {
    return running.wait
  }
  const timers: NodeJS.Timeout[] = []
  const after = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => timers.push(setTimeout(resolve, ms)))
  const loaded = whenBrowserExtensionProfileLoaded(profileId)
  // Ends when every startup extension is in the session or the startup load ends (then they won't be).
  const inSession = whenBrowserExtensionProfileUnloaded(profileId).then(() => {
    const sess = getBrowserExtensionSessionForProfile(profileId)
    return sess ? whenBrowserExtensionsInSession(sess, loaded) : undefined
  })
  const entry: StartWait = { phase, wait: Promise.resolve(), inSession, late: false }
  void inSession.then(() => {
    entry.late = false
  })
  const giveUp = Promise.race([
    loaded,
    after(IN_SESSION_WAIT_LIMIT_MS).then(() => {
      entry.late = true
      console.warn(
        `[browser-extensions] Pages open before ${profileId}'s extensions finished loading`
      )
    })
  ])
  const wait = Promise.all([
    Promise.race([inSession, giveUp]),
    Promise.race([loaded, after(FIRST_LOAD_WAIT_MS)])
  ])
    .then(() => undefined)
    .finally(() => timers.forEach(clearTimeout))
  // Kept until this attach's loads end: later pages share it, and one that gave up isn't repeated.
  void loaded.finally(() => {
    if (startWaits.get(profileId)?.wait === wait) {
      startWaits.delete(profileId)
    }
  })
  entry.wait = wait
  startWaits.set(profileId, entry)
  return wait
}

const heldFirstLoads = new WeakSet<Electron.WebContents>()

/** Its first load is held for its profile's extensions, so it counts as loading already. */
export function isBrowserPageFirstLoadHeld(contents: Electron.WebContents): boolean {
  return heldFirstLoads.has(contents)
}

/** Loads `load` once `ready` settles, unless the page was navigated elsewhere meanwhile. */
export function loadPageWhenReady(
  contents: Electron.WebContents,
  ready: Promise<unknown>,
  load: () => Promise<void>
): Promise<void> {
  heldFirstLoads.add(contents)
  let navigated = false
  const noteNavigation = (): void => {
    navigated = true
    heldFirstLoads.delete(contents)
  }
  contents.once('did-start-navigation', noteNavigation)
  return ready.then(() => {
    heldFirstLoads.delete(contents)
    contents.off('did-start-navigation', noteNavigation)
    return navigated || contents.isDestroyed() ? undefined : load()
  })
}

/** will-attach-webview for a tab that runs extensions: its first load waits for its profile's extensions. */
export function holdWebviewFirstLoadForExtensions(
  embedder: Electron.WebContents,
  profileId: string,
  params: Record<string, string>
): void {
  const src = params.src
  // A blank bootstrap (route pages) sends no request and must finish within the mount deadline.
  if (!src || src === 'about:blank') {
    return
  }
  const ready = whileExtensionsStart(profileId)
  if (!ready) {
    return
  }
  // Electron loads params.src when the guest attaches; without it the guest waits blank.
  delete params.src
  // Why: Electron creates the guest synchronously right after will-attach-webview.
  const claim = (_event: Electron.Event, guest: Electron.WebContents): void => {
    app.off('web-contents-created', claim)
    // Why after attach too: the <webview> only hears the guest's navigation events once attached.
    void loadPageWhenReady(guest, Promise.all([whenAttached(embedder, guest), ready]), () =>
      guest.loadURL(src)
    ).catch(() => {})
  }
  app.on('web-contents-created', claim)
  queueMicrotask(() => app.off('web-contents-created', claim))
}

const attachWaiters = new WeakMap<Electron.WebContents, () => void>()
const watchedEmbedders = new WeakSet<Electron.WebContents>()

function whenAttached(embedder: Electron.WebContents, guest: Electron.WebContents): Promise<void> {
  if (!watchedEmbedders.has(embedder)) {
    watchedEmbedders.add(embedder)
    embedder.on('did-attach-webview', (_event, attached) => attachWaiters.get(attached)?.())
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      attachWaiters.delete(guest)
      guest.off('destroyed', done)
      resolve()
    }
    attachWaiters.set(guest, done)
    guest.once('destroyed', done)
  })
}
