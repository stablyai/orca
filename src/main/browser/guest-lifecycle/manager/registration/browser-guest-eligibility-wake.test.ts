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

import { createEligibilityFleet, EligibilityGuest } from './browser-guest-eligibility-test-fixture'
import { claimBrowserMemoryPage, closeBrowserMemoryPage } from '../../browser-page-memory'
import { createBrowserRouteGuestPopupController } from '../../../routing/guest-authority/browser-route-guest-popups'

let fleet: ReturnType<typeof createEligibilityFleet> | undefined
afterEach(() => {
  fleet?.close()
  fleet = undefined
})

it.each([true, false])(
  'retries the oldest clean page after both native load and restore settle (load first=%s)',
  async (loadFirst) => {
    fleet = createEligibilityFleet(native)
    const { guest, pageId, attempts, freed } = fleet
    guest.clean()
    await Promise.resolve()
    expect(attempts).toEqual([pageId])
    expect(freed).toEqual([])
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve()
    }
    expect(attempts).toEqual([pageId])
    if (loadFirst) {
      guest.stopLoading()
    } else {
      await guest.finishRestore(pageId)
    }
    await Promise.resolve()
    expect(freed).toEqual([])
    if (loadFirst) {
      await guest.finishRestore(pageId)
    } else {
      guest.stopLoading()
    }
    await Promise.resolve()
    expect(freed).toEqual([pageId])
    expect(attempts.every((id) => id === pageId)).toBe(true)
  }
)

it.each(['operation', 'devtools', 'debugger', 'grab', 'popup', 'route-popup'])(
  'retries only the affected page after its %s terminal',
  async (kind) => {
    fleet = createEligibilityFleet(native)
    const { manager, guest, pageId, freed } = fleet
    let release = (): void => {}
    if (kind === 'operation') {
      release = claimBrowserMemoryPage(pageId)
    }
    if (kind === 'devtools') {
      guest.devtools = true
      release = () => {
        guest.devtools = false
        guest.emit('devtools-closed')
      }
    }
    if (kind === 'debugger') {
      guest.debugged = true
      await expect(manager.setViewportOverride(pageId, null)).resolves.toBe(true)
      expect(guest.debugged).toBe(true)
      release = () => {
        guest.debugged = false
        guest.debugger.emit('detach')
      }
    }
    let grabbed: Promise<unknown> | undefined
    if (kind === 'grab') {
      grabbed = manager.awaitGrabSelection(pageId, 'grab', guest.asWebContents())
      release = () => manager.cancelGrabOp(pageId, 'user')
    }
    if (kind === 'popup') {
      const popup = new EligibilityGuest(2)
      native.set(2, popup.asWebContents())
      // The actual native popup event installs its owner and cleanup.
      guest.emit('did-create-window', { webContents: popup.asWebContents() })
      release = () => popup.destroy()
    }
    if (kind === 'route-popup') {
      const popup = new EligibilityGuest(2)
      native.set(2, popup.asWebContents())
      const controller = createBrowserRouteGuestPopupController({
        opener: guest.asWebContents(),
        partition: 'persist:eligibility',
        isNavigationAllowed: () => true,
        dependencies: {
          getPartitionForSession: () => 'persist:eligibility',
          popupReleased: (opener) => manager.invalidateGuestMemoryProtection(opener),
          openPopupWindow: (_options, _url, prepare) => {
            expect(prepare(popup.asWebContents())).toBe(true)
            return {
              contentWebContents: popup.asWebContents(),
              close: () => popup.destroy(),
              onClosed: () => {}
            }
          }
        }
      })
      guest.emit('input-event', {}, { type: 'mouseDown' })
      const response = controller.windowOpenHandler({
        url: 'https://login.test/oauth',
        frameName: 'auth'
      })
      expect(response.action).toBe('allow')
      response.createWindow?.({})
      release = () => {
        popup.destroy()
        controller.dispose()
      }
    }
    guest.clean()
    guest.stopLoading()
    await guest.finishRestore(pageId)
    await Promise.resolve()
    expect(freed).toEqual([])
    release()
    await grabbed
    await Promise.resolve()
    expect(freed).toEqual([pageId])
  }
)

it('keeps repeated default viewport resets debugger-free through actual pool reservation', async () => {
  fleet = createEligibilityFleet(native)
  const { manager, guest, pageId, freed } = fleet
  await expect(manager.setViewportOverride(pageId, null)).resolves.toBe(true)
  await expect(manager.setViewportOverride(pageId, null)).resolves.toBe(true)
  expect(guest.debugger.isAttached()).toBe(false)
  expect(guest.debugger.sendCommand).not.toHaveBeenCalled()
  guest.clean()
  guest.stopLoading()
  await guest.finishRestore(pageId)
  await Promise.resolve()
  expect(freed).toEqual([pageId])
})

it('does not apply a queued old-guest default reset to its replacement', async () => {
  fleet = createEligibilityFleet(native)
  const reset = fleet.manager.setViewportOverride(fleet.pageId, null)
  closeBrowserMemoryPage(fleet.pageId)
  const replacement = fleet.attach(3)
  await expect(reset).resolves.toBe(false)
  expect(replacement.debugger.attach).not.toHaveBeenCalled()
  expect(replacement.debugger.sendCommand).not.toHaveBeenCalled()
})

it('does not free a page from age or lifecycle notifications without count pressure', async () => {
  fleet = createEligibilityFleet(native, 32)
  fleet.guest.clean()
  fleet.guest.stopLoading()
  await fleet.guest.finishRestore(fleet.pageId)
  await Promise.resolve()
  expect(fleet.attempts).toEqual([])
  expect(fleet.freed).toEqual([])
})

it('does not let an old claim release wake a replacement logical page', async () => {
  fleet = createEligibilityFleet(native)
  const release = claimBrowserMemoryPage(fleet.pageId)
  closeBrowserMemoryPage(fleet.pageId)
  const replacement = fleet.attach(3)
  replacement.clean()
  await Promise.resolve()
  const before = [...fleet.attempts]
  release()
  await Promise.resolve()
  expect(fleet.attempts).toEqual(before)
  replacement.stopLoading()
  await replacement.finishRestore(fleet.pageId)
})

it('retries the current guest only when its retired predecessor is actually destroyed', async () => {
  fleet = createEligibilityFleet(native)
  const { guest, pageId, freed } = fleet
  guest.clean()
  guest.stopLoading()
  await guest.finishRestore(pageId)
  await Promise.resolve()
  expect(freed).toEqual([pageId])
  const replacement = fleet.attach(3)
  replacement.clean()
  replacement.stopLoading()
  await replacement.finishRestore(pageId)
  await Promise.resolve()
  expect(freed).toEqual([pageId])
  guest.destroy()
  await Promise.resolve()
  expect(freed).toEqual([pageId, pageId])
})
