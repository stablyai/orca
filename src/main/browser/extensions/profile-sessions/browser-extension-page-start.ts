import { app } from 'electron'
import { getBrowserExtensionProfileIdForSession } from '../api-runtime/browser-extension-api-host'
import {
  getBrowserExtensionSessionForProfile,
  getBrowserExtensionProfileLoadingPhase,
  whenBrowserExtensionProfileLoaded,
  whenBrowserExtensionProfileUnloaded
} from './browser-extension-session-loader'
import { whenBrowserExtensionsInSession } from './browser-extension-session-presence'
import { loadPageWhenReady, startHeldLoad } from './browser-page-held-first-load'

// Why bounded: slow restore hooks must not keep the page from loading.
const FIRST_LOAD_WAIT_MS = 3_000
// Why bounded at all: an extension load that never settles must not leave the page blank forever.
const IN_SESSION_WAIT_LIMIT_MS = 20_000

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

const startWaits = new Map<string, { phase: object; wait: Promise<void> }>()

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
  // Restore hooks get a short bound; the session step a long one, as a load started before it hangs.
  const giveUp = Promise.race([loaded, after(IN_SESSION_WAIT_LIMIT_MS)])
  const wait = Promise.all([
    Promise.race([
      whenBrowserExtensionProfileUnloaded(profileId).then(() => {
        const sess = getBrowserExtensionSessionForProfile(profileId)
        return sess ? whenBrowserExtensionsInSession(sess, giveUp) : undefined
      }),
      giveUp
    ]),
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

/** will-attach-webview for a tab that runs extensions: its first load waits for its profile's extensions. */
export function holdWebviewFirstLoadForExtensions(
  embedder: Electron.WebContents,
  profileId: string,
  params: Record<string, string>
): void {
  const src = params.src
  // A blank bootstrap (route pages) sends no request and must finish within the mount deadline;
  // the route's own first load waits for extensions instead.
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
    void loadPageWhenReady(
      guest,
      Promise.all([whenAttached(embedder, guest), ready]),
      (requested) => (requested ? startHeldLoad(guest, requested, null) : guest.loadURL(src))
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
