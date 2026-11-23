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
  return ready.then(() => {
    heldFirstLoads.delete(contents)
    Reflect.deleteProperty(contents, 'loadURL')
    const queued = requested
    const outcome = contents.isDestroyed()
      ? queued
        ? Promise.reject(new Error('The browser page closed while loading'))
        : Promise.resolve()
      : load(queued ? { url: queued.url, options: queued.options } : null)
    queued?.settle(outcome)
    return outcome
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
 * made after the restore, unless it carries load options, which a history entry can't.
 */
export function startHeldLoad(
  contents: Electron.WebContents,
  requested: HeldLoad,
  history: { entries: Electron.NavigationEntry[]; index: number } | null
): Promise<void> {
  const { url, options } = requested
  if (
    !history ||
    Object.values(options ?? {}).some((value) => value !== undefined && value !== '')
  ) {
    return contents.loadURL(url, options)
  }
  const entries = [...history.entries.slice(0, history.index + 1), { url, title: '' }]
  return contents.navigationHistory.restore({ entries, index: entries.length - 1 })
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
