import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ clipboard: { readText: () => '' } }))
vi.mock('../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))
vi.mock('../browser/cdp/input/agent-input-injection', () => ({
  isAgentInjectingInput: () => false
}))

import {
  registerRemoteDesktopSession,
  resetRemoteDesktopSessionsForTest,
  type RemoteDesktopMintResult
} from './remote-desktop-sessions'
import { isRemoteDesktopGuest, setupRemoteDesktopGuest } from './remote-desktop-guest'

const DESKTOP_URL = 'http://localhost:6081/vnc.html?autoconnect=0&reconnect=0&resize=remote'
const ticket = (n: number): string => String(n).padStart(43, 't')
/** Fixed, far-future expiry: these tests never depend on the clock. */
const FAR_FUTURE = 4_000_000_000_000

/** A guest whose page answers orcaDesktop calls from a script the test controls. */
class FakeGuest extends EventEmitter {
  url = DESKTOP_URL
  focused = false
  destroyed = false
  calls: string[] = []
  /** Pending nextTicketRequest() answers, resolved by the test. */
  private waiters: ((answer: string) => void)[] = []
  connectAnswer = 'connecting'
  pasteAnswer = true

  getURL(): string {
    return this.url
  }
  isLoading(): boolean {
    return false
  }
  isFocused(): boolean {
    return this.focused
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  async executeJavaScript(code: string): Promise<unknown> {
    this.calls.push(code)
    if (code.includes('nextTicketRequest')) {
      return new Promise((resolve) => this.waiters.push(resolve))
    }
    if (code.includes('orcaDesktop.connect(')) {
      return this.connectAnswer
    }
    if (code.includes('orcaDesktop.paste(')) {
      return this.pasteAnswer
    }
    return true
  }
  /** The page asks for a ticket ('ticket') or reports a failed attempt ('retry'). */
  ask(answer: 'ticket' | 'retry'): void {
    this.waiters.shift()?.(answer)
  }
  get waiting(): number {
    return this.waiters.length
  }
  key(input: Partial<Electron.Input>): { prevented: boolean } {
    const event = { prevented: false, preventDefault: () => (event.prevented = true) }
    this.emit('before-input-event', event, {
      type: 'keyDown',
      key: '',
      code: '',
      control: false,
      alt: false,
      meta: false,
      shift: false,
      isAutoRepeat: false,
      ...input
    })
    return event
  }
}

function asWebContents(guest: FakeGuest): Electron.WebContents {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeGuest implements every WebContents member the driver calls (on/off, getURL, isLoading, isFocused, isDestroyed, executeJavaScript).
  return guest as unknown as Electron.WebContents
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function setup(options: { clipboard?: string; platform?: NodeJS.Platform } = {}) {
  const guest = new FakeGuest()
  const minted: string[] = []
  let next = 1
  let mintResult: () => RemoteDesktopMintResult = () => {
    const value = ticket((next += 1))
    minted.push(value)
    return { ok: true, ticket: value, expiresAt: FAR_FUTURE }
  }
  registerRemoteDesktopSession(
    {
      environmentId: 'env-1',
      localPort: 6081,
      path: 'vnc.html',
      mint: async () => mintResult()
    },
    { ticket: ticket(1), expiresAt: FAR_FUTURE }
  )
  const events: unknown[] = []
  const stop = setupRemoteDesktopGuest({
    browserPageId: 'page-1',
    guest: asWebContents(guest),
    platform: options.platform ?? 'darwin',
    notify: (event) => events.push(event),
    readClipboard: () => options.clipboard ?? '',
    sleep: async () => {}
  })
  return {
    guest,
    minted,
    events,
    stop,
    failMint: (reason: 'asleep' | 'unavailable') => {
      mintResult = () => ({ ok: false, reason })
    }
  }
}

const connects = (guest: FakeGuest): string[] =>
  guest.calls.filter((c) => c.includes('orcaDesktop.connect('))

describe('remote desktop page driver', () => {
  beforeEach(() => resetRemoteDesktopSessionsForTest())

  it('hands the page the open’s ticket first, then a fresh one for each reconnect', async () => {
    const { guest } = setup()
    expect(isRemoteDesktopGuest(asWebContents(guest))).toBe(true)
    await flush()
    guest.ask('ticket')
    await flush()
    expect(connects(guest)).toEqual([`window.orcaDesktop.connect("${ticket(1)}")`])
    // The session dropped (forward re-dial, desktop restart): a new ticket, never the spent one.
    guest.ask('ticket')
    await flush()
    expect(connects(guest).at(-1)).toBe(`window.orcaDesktop.connect("${ticket(2)}")`)
  })

  it('pauses with Reconnect after repeated failed attempts instead of spinning', async () => {
    const { guest } = setup()
    await flush()
    // One try and three retries, then the page waits for a person.
    for (let i = 0; i < 5; i += 1) {
      guest.ask(i === 0 ? 'ticket' : 'retry')
      await flush()
    }
    expect(connects(guest)).toHaveLength(4)
    expect(guest.calls.at(-2)).toContain('window.orcaDesktop.pause(')
    expect(guest.calls.at(-2)).toContain('The remote desktop disconnected.')
  })

  it('says the sandbox is asleep when no ticket can be minted, and resumes on reopen', async () => {
    const { guest, failMint } = setup()
    await flush()
    guest.ask('ticket') // uses the open's ticket
    await flush()
    failMint('asleep')
    guest.ask('ticket')
    await flush()
    expect(guest.calls.at(-2)).toContain('This sandbox is asleep.')
    // Open remote desktop again: main wakes the paused page.
    registerRemoteDesktopSession(
      {
        environmentId: 'env-1',
        localPort: 6081,
        path: 'vnc.html',
        mint: async () => ({ ok: false, reason: 'asleep' })
      },
      null
    )
    expect(guest.calls.at(-1)).toContain('orcaDesktop.resume()')
  })

  it('ignores pages that are not this computer’s desktop forwards', async () => {
    resetRemoteDesktopSessionsForTest()
    const guest = new FakeGuest()
    guest.url = 'http://localhost:6081/vnc.html'
    const stop = setupRemoteDesktopGuest({
      browserPageId: 'page-2',
      guest: asWebContents(guest),
      notify: () => {},
      readClipboard: () => 'secret',
      sleep: async () => {}
    })
    await flush()
    expect(isRemoteDesktopGuest(asWebContents(guest))).toBe(false)
    expect(guest.calls).toEqual([])
    expect(guest.key({ key: 'v', code: 'KeyV', meta: true }).prevented).toBe(false)
    stop()
  })

  it('reads the clipboard only on a paste key, and pushes it on every paste', async () => {
    const { guest } = setup({ clipboard: 'from this computer', platform: 'linux' })
    await flush()
    guest.ask('ticket')
    await flush()
    expect(guest.key({ key: 'a', code: 'KeyA', control: true }).prevented).toBe(false)
    expect(guest.calls.some((c) => c.includes('paste('))).toBe(false)
    expect(guest.key({ key: 'v', code: 'KeyV', control: true }).prevented).toBe(true)
    await flush()
    expect(guest.calls.at(-1)).toBe(
      'window.orcaDesktop.paste("from this computer", {"kind":"replay","key":"v"})'
    )
    // Same text again is pushed again: the sandbox's clipboard may have changed meanwhile.
    expect(guest.key({ key: 'v', code: 'KeyV', control: true }).prevented).toBe(true)
    // Auto-repeat of a Linux paste key passes through untouched.
    expect(guest.key({ key: 'v', code: 'KeyV', control: true, isAutoRepeat: true }).prevented).toBe(
      false
    )
  })

  it('turns Cmd+V into a sandbox paste on macOS', async () => {
    const { guest } = setup({ clipboard: 'hi' })
    await flush()
    expect(guest.key({ key: 'v', code: 'KeyV', meta: true }).prevented).toBe(true)
    await flush()
    expect(guest.calls.at(-1)).toBe('window.orcaDesktop.paste("hi", {"kind":"mac"})')
  })

  it('reports keyboard capture and the release chord to the renderer', async () => {
    const { guest, events } = setup()
    guest.focused = true
    guest.emit('focus')
    expect(events.at(-1)).toEqual({
      kind: 'state',
      state: { browserPageId: 'page-1', desktop: true, captured: true }
    })
    guest.key({ type: 'keyDown', key: 'Control', control: true })
    guest.key({ type: 'keyDown', key: 'Meta', control: true, meta: true })
    guest.key({ type: 'keyUp', key: 'Meta', control: true })
    expect(events.at(-1)).toEqual({ kind: 'release' })
  })

  it('never strands a page call when the page goes away mid-call', async () => {
    const { guest } = setup()
    await flush()
    expect(guest.waiting).toBe(1) // nextTicketRequest() pending in the page
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    await flush()
    // The pending call settled (cancelled) and the driver stopped: no connect, no new request.
    expect(connects(guest)).toEqual([])
    expect(guest.calls.filter((c) => c.includes('nextTicketRequest'))).toHaveLength(1)
  })

  it('stops driving the page when it navigates away or the tab closes', async () => {
    const { guest, events, stop } = setup()
    await flush()
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(isRemoteDesktopGuest(asWebContents(guest))).toBe(false)
    guest.ask('ticket')
    await flush()
    expect(connects(guest)).toEqual([])
    guest.url = DESKTOP_URL
    guest.emit('did-finish-load')
    expect(isRemoteDesktopGuest(asWebContents(guest))).toBe(true)
    stop()
    expect(isRemoteDesktopGuest(asWebContents(guest))).toBe(false)
    expect(events.at(-1)).toEqual({
      kind: 'state',
      state: { browserPageId: 'page-1', desktop: false, captured: false }
    })
  })
})
