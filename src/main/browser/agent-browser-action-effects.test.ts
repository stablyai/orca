import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { runWithActionEffects, type ActionEffectsHost } from './agent-browser-action-effects'
import type { BrowserPageEvent } from './browser-page-events'
import { readBrowserActionEffects } from '../../shared/browser-action-effects'

vi.mock('./remote-cli-page-admission', () => ({
  readRemoteCliAdmittedPage: (_id: number, read: () => Promise<unknown>) => read()
}))

// Real agent-browser 0.39.4 `snapshot --delta` replies.
const UNCHANGED = { snapshot: { kind: 'unchanged', baseRevision: 1, revision: 2 } }
const INVALID_LOGIN = {
  snapshot: {
    kind: 'delta',
    baseRevision: 3,
    revision: 4,
    changes: [],
    treeChange: {
      startLine: 12,
      deleteCount: 0,
      lines: ['    - StaticText "Invalid username or password"']
    }
  }
}

function fakeGuest(url = 'http://127.0.0.1/login.html', title = 'Login') {
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    url,
    title,
    getURL: () => guest.url,
    getTitle: () => guest.title,
    isDestroyed: () => false,
    isLoadingMainFrame: () => false,
    executeJavaScriptInIsolatedWorld: vi.fn(async () => true)
  })
  return guest
}

function fakeHost(
  guest: ReturnType<typeof fakeGuest>,
  snapshots: unknown[],
  hasDeltaBaseline = false
) {
  const pageEvents = new Set<(event: BrowserPageEvent) => void>()
  const tabs = new Map<string, string>([['page-1', guest.url]])
  const host: ActionEffectsHost = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the effects layer reads only the guest members faked here.
    guest: () => guest as unknown as WebContents,
    tabUrls: () => new Map(tabs),
    loadError: () => null,
    hasDeltaBaseline: () => hasDeltaBaseline,
    forgetDeltaBaseline: vi.fn(),
    snapshotDelta: vi.fn(async () => {
      const next = snapshots.shift()
      if (next instanceof Error) {
        throw next
      }
      return next
    }),
    observePageEvents: (listener) => {
      pageEvents.add(listener)
      return () => pageEvents.delete(listener)
    },
    admit: vi.fn()
  }
  const emit = (event: BrowserPageEvent): void => pageEvents.forEach((listener) => listener(event))
  return { host, tabs, emit }
}

describe('runWithActionEffects', () => {
  it('says a click that changed nothing changed nothing', async () => {
    const guest = fakeGuest()
    const { host } = fakeHost(guest, [UNCHANGED, UNCHANGED])

    const result = await runWithActionEffects(host, async () => ({ clicked: '@e6' }))

    expect(result).toEqual({ clicked: '@e6', effects: { settled: true, page: 'unchanged' } })
    // One baseline before the action, one reading after it.
    expect(host.snapshotDelta).toHaveBeenCalledTimes(2)
  })

  it('diffs against the last reading without reissuing the refs the agent holds', async () => {
    const guest = fakeGuest()
    const { host } = fakeHost(guest, [INVALID_LOGIN], true)

    await runWithActionEffects(host, async () => {
      // The action must run against the refs the agent last saw.
      expect(host.snapshotDelta).not.toHaveBeenCalled()
      return { clicked: '@e6' }
    })

    expect(host.snapshotDelta).toHaveBeenCalledTimes(1)
  })

  it('lists the lines an action added and the console errors it logged', async () => {
    const guest = fakeGuest()
    const { host } = fakeHost(guest, [UNCHANGED, INVALID_LOGIN])

    const result = await runWithActionEffects(host, async () => {
      guest.emit('console-message', { level: 'error', message: 'Uncaught TypeError: x' })
      guest.emit('console-message', { level: 'info', message: 'booted' })
      return { clicked: '@e6' }
    })

    expect(readBrowserActionEffects(result)).toEqual({
      settled: true,
      consoleErrors: ['Uncaught TypeError: x'],
      page: {
        lines: ['    - StaticText "Invalid username or password"'],
        removedLines: 0,
        full: false,
        truncated: false
      }
    })
  })

  it('waits for a navigation the action started and reports where it landed', async () => {
    const guest = fakeGuest()
    const appTree = '- heading "Welcome ada" [level=1, ref=e9]\n- button "Submit ticket" [ref=e10]'
    const { host } = fakeHost(guest, [UNCHANGED, { snapshot: { kind: 'full', tree: appTree } }])

    const result = await runWithActionEffects(host, async () => {
      guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      // A redirecting submit replaces its first navigation, which then fails as ERR_ABORTED.
      guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
      guest.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://127.0.0.1/submit', true)
      setTimeout(() => {
        guest.url = 'http://127.0.0.1/app.html'
        guest.title = 'App'
        guest.emit('dom-ready')
      }, 120)
      return { clicked: '@e6' }
    })

    expect(readBrowserActionEffects(result)).toEqual({
      settled: true,
      url: 'http://127.0.0.1/app.html',
      title: 'App',
      page: { lines: appTree.split('\n'), removedLines: 0, full: true, truncated: false }
    })
  })

  it('reports a new tab once it opens and a child window separately', async () => {
    const guest = fakeGuest()
    const { host, tabs, emit } = fakeHost(guest, [UNCHANGED, UNCHANGED])

    const result = await runWithActionEffects(host, async () => {
      emit({ kind: 'popup', action: 'window', origin: 'https://accounts.example' })
      emit({ kind: 'tab', url: 'http://127.0.0.1/basic2.html' })
      setTimeout(() => tabs.set('page-2', 'http://127.0.0.1/basic2.html'), 100)
      return { clicked: '@e18' }
    })

    expect(readBrowserActionEffects(result)).toMatchObject({
      newTabs: [{ browserPageId: 'page-2', url: 'http://127.0.0.1/basic2.html' }],
      popups: [{ action: 'window', origin: 'https://accounts.example' }]
    })
  })

  it('does not read a replacement guest the caller was never admitted to', async () => {
    const guest = fakeGuest()
    const replacement = Object.assign(fakeGuest('http://127.0.0.1/app.html', 'App'), { id: 8 })
    const { host } = fakeHost(guest, [UNCHANGED, INVALID_LOGIN])
    let current = guest
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the effects layer reads only the guest members faked here.
    host.guest = () => current as unknown as WebContents

    const result = await runWithActionEffects(host, async () => {
      current = replacement
      return { clicked: '@e6' }
    })

    expect(readBrowserActionEffects(result)).toMatchObject({ url: 'http://127.0.0.1/app.html' })
    expect(readBrowserActionEffects(result)?.page).toBeUndefined()
    expect(host.snapshotDelta).toHaveBeenCalledTimes(1)
  })
})
