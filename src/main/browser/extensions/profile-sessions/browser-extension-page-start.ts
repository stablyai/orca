import { app } from 'electron'
import { getBrowserExtensionProfileIdForSession } from '../api-runtime/browser-extension-api-host'
import {
  isBrowserExtensionProfileLoading,
  whenBrowserExtensionProfileLoaded
} from './browser-extension-session-loader'

// Why bounded: a slow extension must not keep the page from loading.
const FIRST_LOAD_WAIT_MS = 3_000

/**
 * What a page opening in this profile must wait for before its first load, or null when its
 * extensions are not loading. Waiting registers content scripts before the page commits, and
 * keeps its request out of flight while a webRequest extension loads, which Electron would
 * leave hanging. Callers start the profile's extensions first (registry.attachExtensions).
 */
export function whenBrowserExtensionsStartFor(profileId: string): Promise<void> | null {
  return whileExtensionsStart(profileId)
}

/** For a load into an existing page: the same wait, when its profile's extensions are still starting. */
export function whenBrowserExtensionsReadyForPage(
  contents: Electron.WebContents
): Promise<void> | null {
  const profileId = getBrowserExtensionProfileIdForSession(contents.session)
  return profileId ? whileExtensionsStart(profileId) : null
}

const startWaits = new Map<string, Promise<void>>()

// One bounded wait per starting profile, so a later caller never extends the deadline.
function whileExtensionsStart(profileId: string): Promise<void> | null {
  if (!isBrowserExtensionProfileLoading(profileId)) {
    return null
  }
  const running = startWaits.get(profileId)
  if (running) {
    return running
  }
  let timer: NodeJS.Timeout | undefined
  const wait = Promise.race([
    whenBrowserExtensionProfileLoaded(profileId),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, FIRST_LOAD_WAIT_MS)
    })
  ]).finally(() => {
    clearTimeout(timer)
    startWaits.delete(profileId)
  })
  startWaits.set(profileId, wait)
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

/** will-attach-webview for a tab in a local profile: its first load waits for the profile's extensions. */
export function holdWebviewFirstLoadForExtensions(
  embedder: Electron.WebContents,
  profileId: string,
  params: Record<string, string>
): void {
  const ready = whileExtensionsStart(profileId)
  const src = params.src
  if (!ready || !src) {
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
