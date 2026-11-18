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
import { claimBrowserMemoryPage, closeBrowserMemoryPage } from '../../browser-page-memory'
import { runWithActiveRpcCaller } from '../../../../runtime/rpc/callers/active-call'
import { touchBrowserGuestActivity } from '../../../../../renderer/src/components/browser-pane/host-guest/browser-guest-activity'
import { acquireElectronDebugger } from '../../../cdp/debugger/electron-debugger-lease'
import { CdpDebuggerLifecycle } from '../../../cdp/debugger/cdp-debugger-lifecycle'
import { CdpBridgeState } from '../../../cdp/commands/cdp-bridge-state'
import { invalidateBrowserGuestDiscardProtection } from './browser-guest-discard-protection'

let fleet: ReturnType<typeof createEligibilityFleet> | undefined
afterEach(() => {
  fleet?.close()
  fleet = undefined
  vi.restoreAllMocks()
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

it.each(['lease', 'lifecycle', 'viewport'] as const)(
  'publishes %s debugger acquisition before initialization can fail',
  async (kind) => {
    fleet = createEligibilityFleet(native, 32)
    const { guest, manager, pageId, attempts, freed } = fleet
    await clean(guest, pageId)
    const operation = claimBrowserMemoryPage(pageId)
    let release = (): void => guest.debugger.detach()
    let rejectInitialization = (_error: Error): void => {}
    let initialization: Promise<unknown> = Promise.resolve()
    if (kind === 'lease') {
      release = acquireElectronDebugger(guest.asWebContents()).release
    } else {
      const attached = new Promise<void>((resolve) => {
        guest.debugger.sendCommand.mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectInitialization = reject
              resolve()
            })
        )
      })
      if (kind === 'viewport') {
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        initialization = expect(
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
        initialization = expect(
          new CdpDebuggerLifecycle(state).ensureDebuggerAttached(guest.asWebContents())
        ).rejects.toThrow('Initialization failed')
      }
      await attached
    }
    fleet.attach(3, 'pressure')
    await Promise.resolve()
    expect(attempts).toEqual([])
    rejectInitialization(new Error('Initialization failed'))
    await initialization
    operation()
    guest.devtools = true
    guest.emit('devtools-opened')
    release()
    await Promise.resolve()
    expect(freed).toEqual([])
    guest.devtools = false
    guest.emit('devtools-closed')
    await Promise.resolve()
    expect(freed).toEqual([])
    expect(fleet.attempt()).toBe(true)
    expect(freed).toEqual([pageId])
  }
)

it('refuses explicit admission with a missed hint and never inherits a closed page hold', async () => {
  fleet = createEligibilityFleet(native, 32)
  const { guest, pageId, attempts, freed } = fleet
  await clean(guest, pageId)
  guest.debugged = true
  fleet.attach(3, 'pressure')
  fleet.attempt()
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
  expect(freed).toEqual([])
  expect(fleet.attempt()).toBe(true)
  expect(freed).toEqual([pageId])
})
