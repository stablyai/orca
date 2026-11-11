// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => new Map<number, Electron.WebContents>())
const channels = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: (id: number) => native.get(id) ?? null },
  ipcMain: {
    removeHandler: vi.fn(),
    handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
      channels.set(channel, listener),
    removeAllListeners: (channel: string) => channels.delete(channel),
    on: (channel: string, listener: (...args: unknown[]) => void) =>
      channels.set(channel, listener),
    emit: (channel: string, ...args: unknown[]) => channels.get(channel)?.(...args)
  }
}))
vi.mock('../../popups/presentation/popup-origin-bar-window', () => ({
  openPopupWithOriginBar: vi.fn()
}))
vi.mock('../../../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({ userAgent: 'Chrome/140.0.0.0' })
}))
vi.mock('../../../../runtime/rpc/rpc-active-caller', () => ({
  getActiveRpcCaller: () => ({ kind: 'desktop' })
}))

import {
  createEligibilityFleet,
  type EligibilityGuest
} from './browser-guest-eligibility-test-fixture'
import { invokeGuestDiscard } from './browser-guest-sync-reply-test-fixture'
import {
  acknowledgeBrowserPageRemoval,
  claimBrowserMemoryPage,
  isRetiredBrowserGuest
} from '../../browser-page-memory'
import { pages } from '../../browser-page-memory-state'
import {
  browserGuestActivity,
  retiredBrowserGuestResources
} from '../../../../../renderer/src/components/browser-pane/host-guest/browser-guest-activity'

const registry = await vi.importActual<{
  registerPersistentWebview: (id: string, webview: Electron.WebviewTag) => void
  unregisterPersistentWebview: (id: string) => void
  discardPersistentWebview: (id: string, webview: Electron.WebviewTag, guestId: number) => boolean
}>('../../../../../renderer/src/components/browser-pane/host-guest/webview-registry')

let fleet: ReturnType<typeof createEligibilityFleet> | undefined
afterEach(() => {
  vi.restoreAllMocks()
  fleet?.close()
  for (const id of fleet?.pageIds ?? ['oldest']) {
    registry.unregisterPersistentWebview(id)
  }
  document.body.replaceChildren()
  retiredBrowserGuestResources.clear()
  fleet = undefined
})

it.each([false, true])(
  'delivers committed retirement through actual DOM removal and native ack despite cleanup failure=%s',
  async (failCleanup) => {
    let ack: Promise<boolean> | undefined
    let finishAck: (() => void) | undefined
    const awaitingAck = new Promise<void>((resolve) => {
      finishAck = resolve
    })
    let reachedAck: (() => void) | undefined
    const removal = new Promise<void>((resolve) => {
      reachedAck = resolve
    })
    fleet = createEligibilityFleet(native, 33, false, registry.discardPersistentWebview)
    const { guest, pageId, manager } = fleet
    const renderer = native.get(99)
    if (!renderer) {
      throw new Error('Renderer missing')
    }
    const reserve = (args: unknown): boolean => invokeGuestDiscard(renderer, args)
    const acknowledge = vi.fn((args: { browserPageId: string; webContentsId: number }) => {
      const retired = native.get(args.webContentsId)
      if (!retired) {
        throw new Error('Retired native guest missing')
      }
      ack = awaitingAck.then(() =>
        acknowledgeBrowserPageRemoval(args.browserPageId, retired, renderer.id)
      )
      reachedAck?.()
      return ack
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { reserveGuestDiscard: reserve, acknowledgeGuestRemoval: acknowledge } }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this real DOM element supplies the native guest identity used by the registry.
    const webview = Object.assign(document.createElement('webview'), {
      getWebContentsId: () => guest.id
    }) as unknown as Electron.WebviewTag
    document.body.append(webview)
    registry.registerPersistentWebview(pageId, webview)
    expect(reserve({ browserPageId: 'missing', webContentsId: guest.id })).toBe(false)
    expect(reserve({ browserPageId: pageId, webContentsId: guest.id })).toBe(false)
    expect(acknowledge).not.toHaveBeenCalled()
    expect(webview.isConnected).toBe(true)
    guest.clean()
    guest.stopLoading()
    const held = claimBrowserMemoryPage(pageId)
    await guest.finishRestore(pageId)
    expect(reserve({ browserPageId: pageId, webContentsId: guest.id })).toBe(false)
    expect(webview.isConnected).toBe(true)

    let replacement: EligibilityGuest | undefined
    if (failCleanup) {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const send = renderer.send.bind(renderer)
      let failAudio = true
      vi.spyOn(renderer, 'send').mockImplementation((channel, ...args) => {
        if (channel === 'browser:audio-state-changed' && failAudio) {
          failAudio = false
          throw new Error('Renderer publication failed')
        }
        send(channel, ...args)
      })
      const off = guest.off.bind(guest)
      vi.spyOn(guest, 'off').mockImplementation((event, listener) => {
        if (event === 'did-stop-loading') {
          throw new Error('Policy listener removal failed')
        }
        if (event === 'did-navigate' && !replacement) {
          replacement = fleet?.attach(2, pageId, false)
        }
        return off(event, listener)
      })
      const page = pages.get(pageId)
      if (!page) {
        throw new Error('Page missing')
      }
      // Inject the postcommit callback fault; assertions stay at reply, DOM and native ownership boundaries.
      page.releaseThrottle = () => {
        throw new Error('Throttle release failed')
      }
    }
    held()
    vi.spyOn(guest.navigationHistory, 'getAllEntries').mockImplementationOnce(() => {
      throw new Error('Native history read failed')
    })
    expect(reserve({ browserPageId: pageId, webContentsId: guest.id })).toBe(false)
    expect(webview.isConnected).toBe(true)
    expect(acknowledge).not.toHaveBeenCalled()
    await removal
    expect(webview.isConnected).toBe(false)
    expect(acknowledge).toHaveBeenCalledWith({
      browserPageId: pageId,
      webContentsId: guest.id
    })
    expect(guest.isDestroyed()).toBe(false)
    expect(isRetiredBrowserGuest(pageId, guest.id)).toBe(true)
    expect(manager.getAuthorizedGuest(pageId, renderer.id)).toBe(
      replacement?.asWebContents() ?? null
    )
    if (failCleanup) {
      expect(replacement).toBeDefined()
      expect(guest.listenerCount('devtools-closed')).toBe(0)
      expect(replacement?.isDestroyed()).toBe(false)
    }
    expect(retiredBrowserGuestResources.has(guest.id)).toBe(true)
    finishAck?.()
    await ack
    await Promise.resolve()
    expect(guest.isDestroyed()).toBe(true)
    expect(isRetiredBrowserGuest(pageId, guest.id)).toBe(false)
    expect(retiredBrowserGuestResources.has(guest.id)).toBe(false)
    expect(manager.getAuthorizedGuest(pageId, renderer.id)).toBe(
      replacement?.asWebContents() ?? null
    )
  }
)

it.each([
  [33, 1, 32],
  [36, 4, 32],
  [37, 4, 33]
])(
  'retires only the surplus of %i hidden guests through native settlement',
  async (count, pendingCount, retainedCount) => {
    const pending = new Map<number, { release: () => void; completion: Promise<boolean> }>()
    fleet = createEligibilityFleet(native, count, true, registry.discardPersistentWebview)
    const current = fleet
    const renderer = native.get(99)
    if (!renderer) {
      throw new Error('Renderer missing')
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: {
          reserveGuestDiscard: (args: unknown) => invokeGuestDiscard(renderer, args),
          acknowledgeGuestRemoval: (args: { browserPageId: string; webContentsId: number }) => {
            const guest = native.get(args.webContentsId)
            if (!guest) {
              throw new Error('Retired native guest missing')
            }
            let release = (): void => {}
            const gate = new Promise<void>((resolve) => {
              release = resolve
            })
            const completion = gate.then(() =>
              acknowledgeBrowserPageRemoval(args.browserPageId, guest, renderer.id)
            )
            pending.set(guest.id, { release, completion })
            return completion
          }
        }
      }
    })
    const mount = (guest: EligibilityGuest, id: string): Promise<void> => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the DOM element supplies the exact native identity for the real registry path.
      const webview = Object.assign(document.createElement('webview'), {
        getWebContentsId: () => guest.id
      }) as unknown as Electron.WebviewTag
      document.body.append(webview)
      registry.registerPersistentWebview(id, webview)
      guest.clean()
      guest.stopLoading()
      return guest.finishRestore(id)
    }
    await Promise.all([...current.pageIds].map((id, index) => mount(current.guests[index], id)))
    await Promise.resolve()
    expect(current.freed).toHaveLength(pendingCount)
    expect(current.freed[0]).toBe('oldest')
    expect(document.querySelectorAll('webview')).toHaveLength(retainedCount)
    expect(retiredBrowserGuestResources.size).toBe(pendingCount)
    expect(current.guests.every((guest) => !guest.isDestroyed())).toBe(true)
    if (count === 33) {
      current.attempts.length = 0
      for (const guest of current.guests) {
        guest.stopLoading()
      }
      await Promise.resolve()
      expect(current.attempts).toEqual([])
      expect(pending.has(1)).toBe(true)
      for (let id = 1; id <= 4; id++) {
        const pageId = `new-${id}`
        await mount(current.attach(2000 + id, pageId), pageId)
      }
      expect(current.freed).toEqual(['oldest', 'held-1', 'held-2', 'held-3'])
      expect(retiredBrowserGuestResources.size).toBe(4)
      expect(document.querySelectorAll('webview')).toHaveLength(33)
      expect(current.manager.getAuthorizedGuest('new-4', renderer.id)).toBe(native.get(2004))
      expect(current.guests.every((guest) => !guest.isDestroyed())).toBe(true)
      return
    }
    if (count === 37) {
      const first = pending.get(1)
      if (!first) {
        throw new Error('Oldest acknowledgement missing')
      }
      pending.delete(1)
      first.release()
      await first.completion
      await Promise.resolve()
      expect(current.guest.isDestroyed()).toBe(true)
      expect(current.freed).toEqual(['oldest', 'held-1', 'held-2', 'held-3', 'held-4'])
      expect(document.querySelectorAll('webview')).toHaveLength(32)
      expect(retiredBrowserGuestResources.size).toBe(4)
    }
    await Promise.all(
      [...pending.values()].map(async (ack) => {
        ack.release()
        await ack.completion
      })
    )
    await Promise.resolve()
    expect(retiredBrowserGuestResources.size).toBe(0)
    expect(browserGuestActivity.size).toBe(32)
    expect(current.guests.filter((guest) => !guest.isDestroyed())).toHaveLength(32)
  }
)
