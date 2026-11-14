import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { runWithActionEffects, type ActionEffectsHost } from './agent-browser-action-effects'
import type { BrowserPageEvent } from '../../guest-lifecycle/page-activity/browser-page-events'
import { readBrowserActionEffects } from '../../../../shared/browser-action-effects'

vi.mock('../../routing/input-ownership/remote-cli-page-admission', () => ({
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
  return { host }
}

describe('runWithActionEffects', () => {
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
