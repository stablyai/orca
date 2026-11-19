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

/** A page whose scripts finish only when the test says so, in the order they were sent. */
function heldGuest() {
  const finishers: (() => void)[] = []
  const scripts: string[] = []
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    executeJavaScript: vi.fn(
      (script: string) =>
        new Promise<unknown>((resolve) => {
          scripts.push(script)
          finishers.push(() => resolve(undefined))
        })
    )
  })
  return { guest, scripts, finishers }
}

describe('turning the picker off before Draw captures', () => {
  it.each([
    ['no pick is running (a confirmed pick is on screen)', false],
    ['a pick is still running', true]
  ])('settles only after the page has run a teardown when %s', async (_label, running) => {
    const manager = new BrowserManager()
    const { guest, finishers } = heldGuest()
    const cancelGrabOp = vi.spyOn(manager, 'cancelGrabOp').mockImplementation(() => {})
    vi.spyOn(manager, 'hasActiveGrabOp').mockReturnValue(running)

    let settled: boolean | null = null
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setGrabMode only calls executeJavaScript/once/off/isDestroyed, which this fixture implements.
    const disabled = manager.setGrabMode('page-1', false, guest as unknown as Electron.WebContents)
    void disabled.then((ok) => {
      settled = ok
    })
    await Promise.resolve()

    expect(cancelGrabOp).toHaveBeenCalledWith('page-1', 'user')
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(settled).toBeNull()

    finishers[0]?.()
    await expect(disabled).resolves.toBe(true)
  })
})

describe('following page field focus during a pick', () => {
  it('reports a focused page field once armed, follows changes, and forgets it when the picker turns off', async () => {
    const manager = new BrowserManager()
    // Each focus report the page gives, in order; later ones wait until the test releases them.
    const reports: ((value: boolean | null) => void)[] = []
    const guest = Object.assign(new EventEmitter(), {
      id: 8,
      isDestroyed: () => false,
      executeJavaScript: vi.fn((script: string) =>
        script.includes('g.awaitEditable(')
          ? new Promise<boolean | null>((resolve) => reports.push(resolve))
          : Promise.resolve(true)
      )
    })
    vi.spyOn(manager, 'cancelGrabOp').mockImplementation(() => {})
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) {
        await Promise.resolve()
      }
    }

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setGrabMode only calls executeJavaScript/once/off/isDestroyed, which this fixture implements.
    await manager.setGrabMode('page-1', true, guest as unknown as Electron.WebContents)
    await flush()
    expect(manager.isGuestEditableFocused('page-1')).toBe(false)

    reports.at(-1)?.(true)
    await flush()
    expect(manager.isGuestEditableFocused('page-1')).toBe(true)

    reports.at(-1)?.(false)
    await flush()
    expect(manager.isGuestEditableFocused('page-1')).toBe(false)

    reports.at(-1)?.(true)
    await flush()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: setGrabMode only calls executeJavaScript/once/off/isDestroyed, which this fixture implements.
    const page = guest as unknown as Electron.WebContents
    const turningOff = manager.setGrabMode('page-1', false, page)
    expect(manager.isGuestEditableFocused('page-1')).toBe(false)
    await turningOff
  })
})
