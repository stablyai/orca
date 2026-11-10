// Main's side of a remote desktop browser page (a page whose URL names a desktop forward this
// computer opened; see remote-desktop-sessions.ts). Main, not the page, holds the means to mint
// tickets, so it:
// - hands the page one single-use ticket per WebSocket (on load, and after each drop), backing off
//   and pausing on repeated failures; the page offers Reconnect, and reopening from the menu
//   resumes it. Tickets never touch the URL, the tab state or a log.
// - keeps the keyboard in the desktop while it has focus and gives it back to Orca on the release
//   chord (remote-desktop-keyboard.ts), telling the renderer so it can show the hint.
// - pastes this computer's clipboard into the sandbox only on a paste key in the desktop.
import { clipboard } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import { isAgentInjectingInput } from '../browser/cdp/input/agent-input-injection'
import {
  onRemoteDesktopSessionRefreshed,
  remoteDesktopSessionForUrl,
  takeRemoteDesktopTicket,
  type RemoteDesktopMintFailure,
  type RemoteDesktopSession
} from './remote-desktop-sessions'
import {
  createReleaseChordTracker,
  remoteDesktopPasteChord,
  type RemoteDesktopPasteChord
} from './remote-desktop-keyboard'

/** Consecutive connects that never reached the desktop before the page pauses with Reconnect. */
const MAX_FAILED_CONNECTS = 4
const RETRY_DELAYS_MS = [0, 1_000, 2_000, 4_000]
/** Floor between tickets, and a cap per minute, so a page that keeps dropping never spins mints. */
const MIN_MINT_INTERVAL_MS = 1_000
const MAX_MINTS_PER_MINUTE = 10
const MAX_PASTE_CHARS = 1 << 20
const PAGE_READY_TIMEOUT_MS = 10_000

export type RemoteDesktopGuestState = {
  browserPageId: string
  /** The page is a remote desktop with Orca's page glue. */
  desktop: boolean
  /** It has keyboard focus: Orca's shortcuts are off until the release chord. */
  captured: boolean
}

export type RemoteDesktopGuestDeps = {
  browserPageId: string
  guest: Electron.WebContents
  platform?: NodeJS.Platform
  /** Renderer notices: hint visibility, and the release chord (the renderer moves focus out). */
  notify: (event: { kind: 'state'; state: RemoteDesktopGuestState } | { kind: 'release' }) => void
  readClipboard?: () => string
  sleep?: (ms: number) => Promise<void>
}

const guestsWithDesktop = new WeakSet<Electron.WebContents>()

/** True while this guest shows a remote desktop: Orca's guest shortcut forwarding stands down. */
export function isRemoteDesktopGuest(guest: Electron.WebContents): boolean {
  return guestsWithDesktop.has(guest)
}

const WAIT_FOR_REQUEST = `(async () => {
  for (let i = 0; i < ${PAGE_READY_TIMEOUT_MS / 25} && !window.orcaDesktop; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return window.orcaDesktop ? window.orcaDesktop.nextTicketRequest() : 'missing'
})()`

function pauseMessage(reason: RemoteDesktopMintFailure | 'failed'): string {
  switch (reason) {
    case 'asleep':
      return translateMain(
        'components.cloudRemoteDesktop.pageAsleep',
        'This sandbox is asleep. Wake it in Orca, then reconnect.'
      )
    case 'archived':
      return translateMain(
        'components.cloudRemoteDesktop.pageArchived',
        'This sandbox is archived. Unarchive the workspace in Orca, then reconnect.'
      )
    case 'starting':
      return translateMain(
        'components.cloudRemoteDesktop.pageStarting',
        'The sandbox is starting or waking. Reconnect in a moment.'
      )
    case 'signed_out':
      return translateMain(
        'components.cloudRemoteDesktop.pageSignedOut',
        'You’re signed out of Orca Cloud. Sign in, then reconnect.'
      )
    case 'failed':
    case 'unavailable':
      return translateMain(
        'components.cloudRemoteDesktop.pageDisconnected',
        'The remote desktop disconnected. Your files are safe.'
      )
  }
}

export function setupRemoteDesktopGuest(deps: RemoteDesktopGuestDeps): () => void {
  const { guest, browserPageId, notify } = deps
  const platform = deps.platform ?? process.platform
  const readClipboard = deps.readClipboard ?? (() => clipboard.readText())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const releaseChord = createReleaseChordTracker(platform)
  let generation = 0
  let session: RemoteDesktopSession | null = null
  let stopRefreshListener = (): void => {}
  let disposed = false
  let published = ''
  /** Settles every in-flight page call when the page goes away (a torn-down page may never answer). */
  let cancelInFlight = (): void => {}
  let cancelled = new Promise<undefined>((resolve) => {
    cancelInFlight = () => resolve(undefined)
  })
  const cancelPageCalls = (): void => {
    cancelInFlight()
    cancelled = new Promise<undefined>((resolve) => {
      cancelInFlight = () => resolve(undefined)
    })
  }

  const alive = (gen: number): boolean => !disposed && gen === generation && !guest.isDestroyed()
  const publish = (): void => {
    const state = {
      browserPageId,
      desktop: session !== null,
      captured: session !== null && !guest.isDestroyed() && guest.isFocused()
    }
    // Only changes, and nothing at all for ordinary pages' focus churn.
    const key = `${state.desktop}:${state.captured}`
    if (key === published || (!state.desktop && published === '')) {
      return
    }
    published = key
    notify({ kind: 'state', state })
  }
  const run = async (gen: number, code: string): Promise<unknown> => {
    if (!alive(gen)) {
      return undefined
    }
    try {
      return await Promise.race([guest.executeJavaScript(code), cancelled])
    } catch {
      return undefined
    }
  }

  async function driveTickets(gen: number, current: RemoteDesktopSession): Promise<void> {
    let failures = 0
    let refused = false
    let lastMintAt = 0
    let mintTimes: number[] = []
    while (alive(gen)) {
      const ask = await run(gen, WAIT_FOR_REQUEST)
      if (!alive(gen) || (ask !== 'ticket' && ask !== 'retry')) {
        return
      }
      // 'retry': the last ticket never got a session (refused, or the forward was down).
      failures = ask === 'retry' || refused ? failures + 1 : 0
      refused = false
      if (failures >= MAX_FAILED_CONNECTS) {
        failures = 0
        await pause(gen, 'failed')
        continue
      }
      // Even sessions that connect and then drop at once never mint faster than this.
      const sinceLast = Date.now() - lastMintAt
      await sleep(Math.max(RETRY_DELAYS_MS[failures] ?? 4_000, MIN_MINT_INTERVAL_MS - sinceLast))
      // The forward may have closed meanwhile; a page now on that port gets nothing.
      if (!alive(gen) || remoteDesktopSessionForUrl(guest.getURL()) !== current) {
        return
      }
      mintTimes = mintTimes.filter((at) => Date.now() - at < 60_000)
      if (mintTimes.length >= MAX_MINTS_PER_MINUTE) {
        mintTimes = []
        await pause(gen, 'failed')
        continue
      }
      lastMintAt = Date.now()
      mintTimes.push(lastMintAt)
      const minted = await takeRemoteDesktopTicket(current)
      if (!minted.ok) {
        failures = 0
        await pause(gen, minted.reason)
        continue
      }
      const started = await run(gen, `window.orcaDesktop.connect(${JSON.stringify(minted.ticket)})`)
      // Anything but a started attempt still counts against the budget, so this never spins.
      refused = started !== 'connecting'
    }
  }

  async function pause(gen: number, reason: RemoteDesktopMintFailure | 'failed'): Promise<void> {
    const label = translateMain('components.cloudRemoteDesktop.reconnect', 'Reconnect')
    await run(
      gen,
      `window.orcaDesktop.pause(${JSON.stringify(pauseMessage(reason))}, ${JSON.stringify(label)}, ${JSON.stringify(reason === 'asleep' || reason === 'archived' || reason === 'starting' ? 'neutral' : 'error')})`
    )
  }

  const onLoad = (): void => {
    generation += 1
    cancelPageCalls()
    const gen = generation
    stopRefreshListener()
    stopRefreshListener = () => {}
    session = remoteDesktopSessionForUrl(guest.getURL())
    if (session) {
      guestsWithDesktop.add(guest)
      // Reopening from the menu resumes a page that stopped retrying (asleep, then woken).
      stopRefreshListener = onRemoteDesktopSessionRefreshed(session.localPort, () => {
        void run(gen, 'window.orcaDesktop && window.orcaDesktop.resume()')
      })
      void driveTickets(gen, session)
    } else {
      guestsWithDesktop.delete(guest)
    }
    publish()
  }

  const onNavigate = (
    details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ): void => {
    if (details.isMainFrame && !details.isSameDocument && session) {
      // Leaving the page: stop handing it tickets until the next load says what it is.
      generation += 1
      cancelPageCalls()
      session = null
      guestsWithDesktop.delete(guest)
      stopRefreshListener()
      publish()
    }
  }

  // Async by nature: keys typed in the same instant can reach the sandbox before the replayed one.
  const pasteInto = async (
    gen: number,
    text: string,
    chord: RemoteDesktopPasteChord
  ): Promise<void> => {
    await run(gen, `window.orcaDesktop.paste(${JSON.stringify(text)}, ${JSON.stringify(chord)})`)
  }

  const onInput = (event: Electron.Event, input: Electron.Input): void => {
    if (!session || isAgentInjectingInput(guest)) {
      return
    }
    if (releaseChord(input)) {
      notify({ kind: 'release' })
      return
    }
    const chord = remoteDesktopPasteChord(input, platform)
    if (!chord) {
      return
    }
    if (input.isAutoRepeat) {
      if (chord.kind === 'mac') {
        event.preventDefault()
      }
      return
    }
    // Read only on a paste key in the desktop: the sandbox never sees the clipboard otherwise.
    const text = readClipboard()
    if (!text || text.length > MAX_PASTE_CHARS) {
      return
    }
    // Always pushed: the sandbox's clipboard may have changed by a route that never reached
    // this computer (an agent's xclip), so "it already has this text" cannot be assumed.
    event.preventDefault()
    void pasteInto(generation, text, chord)
  }

  guest.on('did-finish-load', onLoad)
  guest.on('did-start-navigation', onNavigate)
  guest.on('before-input-event', onInput)
  guest.on('focus', publish)
  guest.on('blur', publish)
  if (!guest.isLoading() && guest.getURL()) {
    onLoad()
  }
  return () => {
    disposed = true
    cancelPageCalls()
    stopRefreshListener()
    guestsWithDesktop.delete(guest)
    try {
      guest.off('did-finish-load', onLoad)
      guest.off('did-start-navigation', onNavigate)
      guest.off('before-input-event', onInput)
      guest.off('focus', publish)
      guest.off('blur', publish)
    } catch {
      // The guest may already be destroyed.
    }
    if (session) {
      session = null
      publish()
    }
  }
}
