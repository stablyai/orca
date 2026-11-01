import { setTimeout as delay } from 'node:timers/promises'
import type { WebContents } from 'electron'
import type { BrowserActionEffects } from '../../shared/runtime-browser-contracts'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import type { BrowserPageEvent } from './browser-page-events'
import { readRemoteCliAdmittedPage } from './remote-cli-page-admission'
import { readPageChange } from './agent-browser-snapshot-delta'
import { isLoadingMainFrame } from './agent-browser-bridge-process'

// Settle like ChatGPT's browser: wait for a started navigation, then for a short DOM-quiet window.
const NAVIGATION_START_GRACE_MS = 50
const NAVIGATION_SETTLE_MS = 5_000
const QUIET_BUDGET_MS = 750
const QUIET_MS = 100
const POLL_MS = 50
const TEXT_CHARS = 300
// Long enough that a goto's own url and its settled one compare equal.
const URL_CHARS = 2_000
const LIST_ITEMS = 5
// Clear of Electron's 999, extension worlds and the 1207/1998/1999 Orca already uses.
const DOM_QUIET_WORLD_ID = 1_208

export type ActionEffectsHost = {
  /** The page's current guest; a process swap can replace it during the action. */
  guest: () => WebContents | null
  /** The page's workspace tabs by page id, with each url, or null when the caller may not read it. */
  tabUrls: () => Map<string, string | null>
  loadError: () => string | null
  /** False until this helper session has a `snapshot --delta` baseline to diff against. */
  hasDeltaBaseline: () => boolean
  forgetDeltaBaseline: () => void
  snapshotDelta: () => Promise<unknown>
  observePageEvents: (listener: (event: BrowserPageEvent) => void) => () => void
  admit: (webContentsId: number) => void
}

/** Runs an agent action and adds what it caused, settled within NAVIGATION_SETTLE_MS + QUIET_BUDGET_MS. */
export async function runWithActionEffects<T>(
  host: ActionEffectsHost,
  action: () => Promise<T>
): Promise<T> {
  const guest = host.guest()
  if (!guest) {
    return action()
  }
  const start = {
    guestId: guest.id,
    url: guest.getURL(),
    title: guest.getTitle(),
    loadError: host.loadError()
  }
  const startTabs = new Set(host.tabUrls().keys())
  const watch = watchGuest(guest)
  const events: BrowserPageEvent[] = []
  const unobserve = host.observePageEvents((event) => events.push(event))
  try {
    // Later actions diff against the last reading, which is what the agent saw; a fresh
    // snapshot here would also reissue refs for re-rendered nodes the agent still holds.
    if (!host.hasDeltaBaseline()) {
      // A pending confirm refuses snapshots; the first reading is then the whole page.
      await host.snapshotDelta().catch(() => undefined)
      host.admit(guest.id)
    }
    const result = await action()
    const effects = await settle(host, watch, events, start, startTabs)
    return isRecord(result) ? { ...result, effects: withoutStated(effects, result) } : result
  } finally {
    watch.stop()
    unobserve()
  }
}

async function settle(
  host: ActionEffectsHost,
  watch: GuestWatch,
  events: BrowserPageEvent[],
  start: { guestId: number; url: string; title: string; loadError: string | null },
  startTabs: Set<string>
): Promise<BrowserActionEffects> {
  const navigationDeadline = Date.now() + NAVIGATION_SETTLE_MS
  await delay(NAVIGATION_START_GRACE_MS)
  let loading = !(await watch.navigationSettled(navigationDeadline))
  const quietDeadline = Date.now() + QUIET_BUDGET_MS
  const liveGuest = (): WebContents | null => {
    const guest = host.guest()
    return guest && !guest.isDestroyed() ? guest : null
  }

  // A matched tab keeps its id even if it redirects away from the requested url.
  const matchedTabIds = new Map<BrowserPageEvent, string>()
  const matchRequestedTabs = (): { browserPageId?: string; url: string }[] => {
    const requests = events.filter((event) => event.kind === 'tab')
    const claimed = new Set(matchedTabIds.values())
    const opened = [...host.tabUrls()].filter(([id]) => !startTabs.has(id) && !claimed.has(id))
    const unmatched = requests.filter((request) => !matchedTabIds.has(request))
    for (const request of unmatched) {
      const index = opened.findIndex(([, url]) => url === request.url)
      if (index !== -1) {
        matchedTabIds.set(request, opened.splice(index, 1)[0][0])
      }
    }
    // Tabs that redirected before they were seen still pair up when only they are left.
    const leftover = unmatched.filter((request) => !matchedTabIds.has(request))
    if (leftover.length > 0 && leftover.length === opened.length) {
      leftover.forEach((request, index) => matchedTabIds.set(request, opened[index][0]))
    }
    return requests.map((request) => {
      const browserPageId = matchedTabIds.get(request)
      return browserPageId ? { browserPageId, url: request.url } : { url: request.url }
    })
  }
  const waitForRequestedTabs = async (): Promise<void> => {
    while (matchRequestedTabs().some((tab) => !tab.browserPageId) && Date.now() < quietDeadline) {
      await delay(POLL_MS)
    }
  }

  let quiet = false
  const settling = liveGuest()
  if (settling && !loading) {
    const navigations = watch.navigations()
    // A slow tab registration must not eat the page's own quiet window.
    ;[quiet] = await Promise.all([
      waitForDomQuiet(settling, quietDeadline - Date.now()),
      waitForRequestedTabs()
    ])
    // A script can start a navigation after the grace window; the new document needs its own quiet.
    loading = !(await watch.navigationSettled(navigationDeadline))
    const renavigated = liveGuest()
    if (!loading && renavigated && watch.navigations() !== navigations) {
      quiet = await waitForDomQuiet(renavigated, QUIET_BUDGET_MS)
    }
  } else {
    await waitForRequestedTabs()
  }
  const effects: BrowserActionEffects = { settled: false }
  // Registration can replace the guest while settling; a vanished one has nothing left to read.
  const current = liveGuest()
  if (current) {
    host.admit(current.id)
    const url = current.getURL()
    const title = current.getTitle()
    if (url !== start.url) {
      effects.url = clip(url, URL_CHARS)
    }
    if (url !== start.url || title !== start.title) {
      effects.title = clip(title)
    }
    const replaced = current.id !== start.guestId
    const stillLoading = loading || (replaced && isLoadingMainFrame(current))
    // A replacement guest was never admitted for this caller, so only the original is read.
    if (!replaced) {
      try {
        const reply = await host.snapshotDelta()
        host.admit(current.id)
        // An unfinished navigation would show the outgoing document.
        if (!stillLoading) {
          effects.page = readPageChange(reply)
        }
      } catch {
        // Unread: no `page`, so the agent snapshots.
      }
    }
    if (stillLoading) {
      effects.loading = true
    }
    effects.settled = !effects.loading && quiet
    const loadError = host.loadError()
    if (loadError && loadError !== start.loadError) {
      effects.loadError = clip(loadError)
    }
  }

  if (effects.page === undefined) {
    // The agent did not see this reading, so the next action must not diff against it.
    host.forgetDeltaBaseline()
  }
  effects.newTabs = firstItems(matchRequestedTabs().map((tab) => ({ ...tab, url: clip(tab.url) })))
  const popups = events.flatMap((event) =>
    event.kind === 'popup' ? [{ action: event.action, origin: clip(event.origin) }] : []
  )
  effects.popups = firstItems(popups)
  effects.downloads = firstItems(
    events.flatMap((event) =>
      event.kind === 'download'
        ? [{ filename: clip(event.filename), origin: clip(event.origin) }]
        : []
    )
  )
  effects.consoleErrors = firstItems(watch.consoleErrors.map((error) => clip(error)))
  return effects
}

type GuestWatch = {
  consoleErrors: string[]
  /** Main-frame cross-document navigations started so far. */
  navigations: () => number
  /** Resolves false when a main-frame navigation is still loading at the deadline. */
  navigationSettled: (deadline: number) => Promise<boolean>
  stop: () => void
}

function watchGuest(guest: WebContents): GuestWatch {
  let navigating = false
  let navigations = 0
  let onSettled: (() => void) | null = null
  const consoleErrors: string[] = []
  const finishNavigation = (): void => {
    navigating = false
    onSettled?.()
  }
  const onStart = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    // Busy iframes and same-document route changes never block the settle.
    if (details.isMainFrame && !details.isSameDocument) {
      navigating = true
      navigations += 1
    }
  }
  const onFail = (
    _event: Electron.Event,
    code: number,
    _description: string,
    _url: string,
    isMainFrame: boolean
  ): void => {
    // ERR_ABORTED is a navigation another one replaced; did-stop-loading ends a real abort.
    if (isMainFrame && code !== -3) {
      finishNavigation()
    }
  }
  const onConsole = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => {
    if (details.level === 'error' && consoleErrors.length < LIST_ITEMS) {
      consoleErrors.push(details.message)
    }
  }
  guest.on('did-start-navigation', onStart)
  guest.on('dom-ready', finishNavigation)
  // A navigation that turns into a download never reaches dom-ready.
  guest.on('did-stop-loading', finishNavigation)
  guest.on('did-fail-load', onFail)
  guest.on('destroyed', finishNavigation)
  guest.on('console-message', onConsole)
  return {
    consoleErrors,
    navigations: () => navigations,
    navigationSettled: (deadline) =>
      new Promise((resolve) => {
        if (!navigating) {
          resolve(true)
          return
        }
        const timer = setTimeout(() => finish(false), Math.max(0, deadline - Date.now()))
        const finish = (settled: boolean): void => {
          clearTimeout(timer)
          onSettled = null
          resolve(settled)
        }
        onSettled = () => finish(true)
      }),
    stop: () => {
      guest.removeListener('did-start-navigation', onStart)
      guest.removeListener('dom-ready', finishNavigation)
      guest.removeListener('did-stop-loading', finishNavigation)
      guest.removeListener('did-fail-load', onFail)
      guest.removeListener('destroyed', finishNavigation)
      guest.removeListener('console-message', onConsole)
    }
  }
}

// Resolves true once the DOM went quietMs without mutations, false at the cap.
const DOM_QUIET_PROBE = `(quietMs, capMs) => new Promise((resolve) => {
  let quiet
  const done = (settled) => { observer.disconnect(); clearTimeout(quiet); clearTimeout(cap); resolve(settled) }
  const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(() => done(true), quietMs) })
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  quiet = setTimeout(() => done(true), quietMs)
  const cap = setTimeout(() => done(false), capMs)
})`

/** A blocking dialog or the budget ends the probe false. */
function waitForDomQuiet(guest: WebContents, budgetMs: number): Promise<boolean> {
  if (budgetMs <= 0 || guest.isDestroyed()) {
    return Promise.resolve(false)
  }
  const code = `(${DOM_QUIET_PROBE})(${QUIET_MS}, ${budgetMs})`
  const probe = readRemoteCliAdmittedPage(guest.id, () =>
    guest.executeJavaScriptInIsolatedWorld(DOM_QUIET_WORLD_ID, [{ code }])
  ).then((settled) => settled === true)
  return withTimeout(probe, budgetMs, false)
}

/** The action's own result already says where the page is; effects repeat only what moved on since. */
function withoutStated(
  effects: BrowserActionEffects,
  result: Record<string, unknown>
): BrowserActionEffects {
  const { url, title, ...rest } = effects
  const urlStated =
    url === undefined || (typeof result.url === 'string' && clip(result.url, URL_CHARS) === url)
  const titleStated =
    title === undefined || (typeof result.title === 'string' && clip(result.title) === title)
  return { ...rest, ...(urlStated ? {} : { url }), ...(urlStated && titleStated ? {} : { title }) }
}

function firstItems<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items.slice(0, LIST_ITEMS) : undefined
}

function clip(text: string, max = TEXT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
