import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { BrowserManager } from '../browser-manager'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  WebContentsView: class {},
  app: { getPath: () => '/downloads' },
  clipboard: { writeText: vi.fn() },
  shell: { openExternal: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  webContents: { fromId: () => null }
}))

/** A page whose main-world scripts finish only when the test says so; isolated-world replies are queued too. */
function heldGuest() {
  const mainWorld: (() => void)[] = []
  const isolatedReplies: ((value: boolean | null) => void)[] = []
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    // Overlay scripts wait for the test; the painted-frame wait answers at once (proven in real Electron).
    executeJavaScript: (script: string) =>
      script.includes('requestAnimationFrame')
        ? Promise.resolve(true)
        : new Promise<unknown>((resolve) => {
            mainWorld.push(() => resolve(true))
          }),
    executeJavaScriptInIsolatedWorld: (_world: number, scripts: { code: string }[]) =>
      scripts[0]?.code.includes('current.await(')
        ? new Promise<boolean | null>((resolve) => isolatedReplies.push(resolve))
        : Promise.resolve(true)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setGrabMode and the watch only call executeJavaScript, executeJavaScriptInIsolatedWorld, on/off/once and isDestroyed, which this fixture implements.
  const page = guest as unknown as Electron.WebContents
  return { guest, page, mainWorld, isolatedReplies }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

describe('turning the picker off before Draw captures', () => {
  it('settles only after the page has finished the teardown script', async () => {
    const manager = new BrowserManager()
    const { page, mainWorld } = heldGuest()
    let settled = false
    const off = manager.setGrabMode('page-1', false, page).then((ok) => {
      settled = true
      return ok
    })
    await flush()
    expect(settled).toBe(false)

    for (const finish of mainWorld.splice(0)) {
      finish()
    }

    await expect(off).resolves.toBe(true)
  })
})

describe("a pick's view of page field focus", () => {
  it('follows the page once armed, treats unknown as a field, and forgets it when the picker turns off', async () => {
    const manager = new BrowserManager()
    const { page, mainWorld, isolatedReplies } = heldGuest()
    const armed = manager.setGrabMode('page-1', true, page)
    await flush()
    for (const finish of mainWorld.splice(0)) {
      finish()
    }
    await armed
    await flush()
    // No report yet: unknown, so letters stay with the page.
    expect(manager.isGuestEditableFocused('page-1')).toBe(true)

    isolatedReplies.shift()?.(false)
    await flush()
    expect(manager.isGuestEditableFocused('page-1')).toBe(false)

    manager.markGuestFocusUnknown('page-1')
    expect(manager.isGuestEditableFocused('page-1')).toBe(true)
    isolatedReplies.shift()?.(true)
    await flush()
    isolatedReplies.shift()?.(false)
    await flush()
    expect(manager.isGuestEditableFocused('page-1')).toBe(false)

    const off = manager.setGrabMode('page-1', false, page)
    expect(manager.isGuestEditableFocused('page-1')).toBe(true)
    await flush()
    for (const finish of mainWorld.splice(0)) {
      finish()
    }
    await off
  })

  it('stops following on a new document: the old answers no longer describe the page', async () => {
    const manager = new BrowserManager()
    const { guest, page, mainWorld, isolatedReplies } = heldGuest()
    const armed = manager.setGrabMode('page-1', true, page)
    await flush()
    for (const finish of mainWorld.splice(0)) {
      finish()
    }
    await armed
    await flush()
    isolatedReplies.shift()?.(false)
    await flush()
    expect(manager.isGuestEditableFocused('page-1')).toBe(false)

    guest.emit('did-start-navigation', {}, 'https://example.test/next', false, true)
    isolatedReplies.shift()?.(false)
    await flush()

    expect(manager.isGuestEditableFocused('page-1')).toBe(true)
  })
})
