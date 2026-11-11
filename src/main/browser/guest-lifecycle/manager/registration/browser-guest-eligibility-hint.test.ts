import { afterEach, beforeEach, expect, it, vi } from 'vitest'

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
    removeHandler: (channel: string) => channels.delete(channel),
    handle: (channel: string, listener: (...args: unknown[]) => unknown) =>
      channels.set(channel, listener),
    removeAllListeners: (channel: string) => channels.delete(channel),
    on: (channel: string, listener: (...args: unknown[]) => unknown) =>
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

import { createEligibilityFleet } from './browser-guest-eligibility-test-fixture'
import {
  claimBrowserMemoryPage,
  closeBrowserMemoryPage,
  retainBrowserMemoryPageForAgent
} from '../../browser-page-memory'
import { runWithActiveRpcCaller } from '../../../../runtime/rpc/rpc-active-caller'
import {
  browserGuestActivity,
  touchBrowserGuestActivity,
  setBrowserGuestVisible
} from '../../../../../renderer/src/components/browser-pane/host-guest/browser-guest-activity'
import { installBrowserPageDownloadActivityTracking } from '../../../../../renderer/src/components/browser-pane/navigate/browser-page-download-activity'
import { acquireElectronDebugger } from '../../../cdp/debugger/electron-debugger-lease'
import { CdpDebuggerLifecycle } from '../../../cdp/debugger/cdp-debugger-lifecycle'
import { CdpBridgeState } from '../../../cdp/commands/cdp-bridge-state'
import { invalidateBrowserGuestDiscardProtection } from './browser-guest-discard-protection'

const { onBrowserGuestPaintRetentionChange } = await vi.importActual<{
  onBrowserGuestPaintRetentionChange: (listener: (pageId: string) => void) => () => void
}>('../../../../../renderer/src/components/browser-pane/host-guest/browser-guest-paint-retention')
const { acquireBrowserAutomationVisibility, releaseBrowserAutomationVisibility } =
  await vi.importActual<{
    acquireBrowserAutomationVisibility: (pageId: string) => string
    releaseBrowserAutomationVisibility: (token: string) => boolean
  }>('../../../../../renderer/src/components/browser-pane/host-guest/browser-automation-visibility')

let fleet: ReturnType<typeof createEligibilityFleet> | undefined
const stops: (() => void)[] = []
beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: 5_000_000 }))
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  fleet?.close()
  fleet = undefined
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function agent<T>(action: () => T): T {
  return runWithActiveRpcCaller({ kind: 'local-cli' }, action)
}
async function clean(
  guest: ReturnType<typeof createEligibilityFleet>['guest'],
  id: string
): Promise<void> {
  guest.clean()
  guest.stopLoading()
  await guest.finishRestore(id)
  await Promise.resolve()
}

it.each([100, 1000])(
  'excludes %i main-owned held pages on repeated native and local retention wakes',
  async (count) => {
    fleet = createEligibilityFleet(native, count, true)
    const { guests, pageIds, attempts } = fleet
    const ids = [...pageIds]
    for (const id of ids) {
      setBrowserGuestVisible(id, true)
      setBrowserGuestVisible(id, false)
      agent(() => claimBrowserMemoryPage(id))()
    }
    vi.setSystemTime(Date.now() + 31 * 60_000)
    for (let i = 0; i < count; i++) {
      await clean(guests[i], ids[i])
    }
    expect(attempts).toEqual([])
    stops.push(onBrowserGuestPaintRetentionChange(touchBrowserGuestActivity))
    let requested = (_event: { downloadId: string; browserPageId: string }): void => {}
    let finished = (_event: { downloadId: string }): void => {}
    vi.stubGlobal('window', {
      api: {
        browser: {
          onDownloadRequested: (listener: typeof requested) => {
            requested = listener
            return () => {}
          },
          onDownloadFinished: (listener: typeof finished) => {
            finished = listener
            return () => {}
          }
        }
      }
    })
    stops.push(installBrowserPageDownloadActivityTracking(touchBrowserGuestActivity))
    for (let turn = 0; turn < 3; turn++) {
      for (let i = 0; i < count; i++) {
        guests[i].emit('did-navigate-in-page', {}, guests[i].getURL(), true)
        guests[i].stopLoading()
        claimBrowserMemoryPage(ids[i])()
        await Promise.resolve()
      }
      const token = acquireBrowserAutomationVisibility(ids[0])
      releaseBrowserAutomationVisibility(token)
      requested({ downloadId: `download-${turn}`, browserPageId: ids[0] })
      finished({ downloadId: `download-${turn}` })
      guests[0].clean()
      await Promise.resolve()
      expect(attempts).toEqual([])
    }
    const reads = vi.spyOn(browserGuestActivity, 'get')
    fleet.attach(5000, 'unrelated')
    await Promise.resolve()
    expect(reads).toHaveBeenCalledWith('unrelated')
    expect(reads.mock.calls.every(([id]) => id === 'unrelated')).toBe(true)
  }
)

it.each(['claim', 'retain', 'pending'] as const)(
  'publishes the first %s hold before pressure can select the page',
  async (kind) => {
    fleet = createEligibilityFleet(native, 32)
    const { guest, pageId, attempts } = fleet
    await clean(guest, pageId)
    if (kind === 'pending') {
      agent(() => retainBrowserMemoryPageForAgent(pageId))
      agent(() => retainBrowserMemoryPageForAgent('accepted', native.get(99)))
      const accepted = fleet.attach(3, 'accepted')
      await clean(accepted, 'accepted')
    } else {
      agent(() =>
        kind === 'claim'
          ? claimBrowserMemoryPage(pageId)()
          : retainBrowserMemoryPageForAgent(pageId)
      )
      fleet.attach(3, 'pressure')
      await Promise.resolve()
      expect(
        channels.get('browser:getGuestDiscardProtection')?.(
          { sender: native.get(99) },
          { browserPageId: pageId, webContentsId: guest.id }
        )
      ).toMatchObject({ protection: 'protected', reason: 'held' })
    }
    expect(attempts).toEqual([])
  }
)

it.each(['lease', 'lifecycle', 'viewport'] as const)(
  'publishes %s debugger acquisition before initialization can fail',
  async (kind) => {
    fleet = createEligibilityFleet(native, 32)
    const { guest, manager, pageId, attempts, freed } = fleet
    await clean(guest, pageId)
    const operation = claimBrowserMemoryPage(pageId)
    let release = (): void => guest.debugger.detach()
    if (kind === 'lease') {
      release = acquireElectronDebugger(guest.asWebContents()).release
    } else {
      guest.debugger.sendCommand.mockRejectedValue(new Error('Initialization failed'))
      if (kind === 'viewport') {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        await expect(
          manager.setViewportOverride(pageId, {
            width: 375,
            height: 667,
            deviceScaleFactor: 2,
            mobile: true
          })
        ).resolves.toBe(false)
      } else {
        const state = new CdpBridgeState({
          getActiveWebContentsId: () => guest.id,
          setActiveWebContentsId: () => {},
          getRegisteredTabs: () => manager.getWebContentsIdByTabId(),
          getTabIdForWebContentsId: (id) => manager.getTabIdForWebContentsId(id),
          tabState: new Map(),
          commandQueues: new Map(),
          processingQueues: new Set()
        })
        await expect(
          new CdpDebuggerLifecycle(state).ensureDebuggerAttached(guest.asWebContents())
        ).rejects.toThrow('Initialization failed')
      }
    }
    operation()
    fleet.attach(3, 'pressure')
    await Promise.resolve()
    expect(attempts).toEqual([])
    guest.devtools = true
    guest.emit('devtools-opened')
    release()
    await Promise.resolve()
    expect(freed).toEqual([])
    guest.devtools = false
    guest.emit('devtools-closed')
    await Promise.resolve()
    expect(freed).toEqual([pageId])
  }
)

it('repairs a missed acquisition hint once and never inherits a closed page hold', async () => {
  fleet = createEligibilityFleet(native, 32)
  const { guest, pageId, attempts, freed } = fleet
  await clean(guest, pageId)
  guest.debugged = true
  fleet.attach(3, 'pressure')
  await Promise.resolve()
  expect(attempts).toEqual([pageId])
  for (let i = 0; i < 5; i++) {
    touchBrowserGuestActivity(pageId)
    await Promise.resolve()
  }
  expect(attempts).toEqual([pageId])
  agent(() => claimBrowserMemoryPage(pageId))()
  guest.debugger.detach()
  await Promise.resolve()
  expect(freed).toEqual([])
  closeBrowserMemoryPage(pageId)
  const replacement = fleet.attach(5)
  invalidateBrowserGuestDiscardProtection(guest.asWebContents())
  await clean(replacement, pageId)
  expect(freed).toEqual([pageId])
})
