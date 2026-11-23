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
export const FIRST_LOAD_WAIT_MS = 3_000
// Why this bound: inside the 8 s tab registration and 15 s recovery deadlines that wrap a page's
// creation; past it a stalled page shows the "Waiting for <host>…" notice and reloads by hand.
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
  contents: Electron.WebContents,
  /** A caller holding a shared slot while it waits keeps main's shorter bound. */
  maxWaitMs?: number
): Promise<void> | null {
  const profileId = getBrowserExtensionProfileIdForSession(contents.session)
  const wait = profileId ? whileExtensionsStart(profileId) : null
  return wait && untilClosed(contents, wait, maxWaitMs)
}

function untilClosed(
  contents: Electron.WebContents,
  wait: Promise<void>,
  maxWaitMs: number | undefined
): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = maxWaitMs === undefined ? undefined : setTimeout(() => done(), maxWaitMs)
    const done = (): void => {
      clearTimeout(timer)
      contents.off('destroyed', done)
      resolve()
    }
    contents.once('destroyed', done)
    void wait.then(done)
  })
}

type StartWait = { phase: object; wait: Promise<void> }
const startWaits = new Map<string, StartWait>()

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
  const deadline = after(IN_SESSION_WAIT_LIMIT_MS)
  // Past the startup load or the bound nothing waits on presence, so its observer goes with them.
  let over = false
  const stop = Promise.race([loaded, deadline]).finally(() => (over = true))
  // Ends when every startup extension is in the session or the startup load ends (then they won't be).
  const inSession = whenBrowserExtensionProfileUnloaded(profileId).then(() => {
    const sess = over ? null : getBrowserExtensionSessionForProfile(profileId)
    return sess ? whenBrowserExtensionsInSession(sess, stop) : undefined
  })
  const giveUp = Promise.race([
    loaded,
    deadline.then(() => {
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
  startWaits.set(profileId, { phase, wait })
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
  const starting = src ? whileExtensionsStart(profileId) : null
  if (!src || !starting) {
    return
  }
  // A blank bootstrap (This-device pages) keeps main's bound to fit their 5 s mount deadline.
  const ready = src === 'about:blank' ? withinFirstLoadWait(starting) : starting
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

function withinFirstLoadWait(wait: Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    wait,
    new Promise<void>((resolve) => (timer = setTimeout(resolve, FIRST_LOAD_WAIT_MS)))
  ]).finally(() => clearTimeout(timer))
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
