import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AppWindowLookup from './app-window-lookup'

type FakeWindow = { id: number; destroyed: boolean; once: (event: string, fn: () => void) => void }

const windows: FakeWindow[] = []
const closedHandlers = new Map<number, () => void>()

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () =>
      windows.map((w) => ({
        id: w.id,
        isDestroyed: () => w.destroyed,
        once: w.once
      }))
  }
}))

function makeWindow(id: number, destroyed = false): FakeWindow {
  const win: FakeWindow = {
    id,
    destroyed,
    once: (event, fn) => {
      if (event === 'closed') {
        closedHandlers.set(id, fn)
      }
    }
  }
  windows.push(win)
  return win
}

let lookup: typeof AppWindowLookup

beforeEach(async () => {
  windows.length = 0
  closedHandlers.clear()
  vi.resetModules()
  lookup = await import('./app-window-lookup')
})

afterEach(() => {
  lookup.resetChromeWindowRegistryForTests()
})

describe('findAppWindow', () => {
  it('returns the only app window', () => {
    makeWindow(1)
    expect(lookup.findAppWindow()?.id).toBe(1)
  })

  it('skips destroyed windows', () => {
    makeWindow(1, true)
    makeWindow(2)
    expect(lookup.findAppWindow()?.id).toBe(2)
  })

  it('returns null when there are no windows at all', () => {
    expect(lookup.findAppWindow()).toBeNull()
  })

  it('never returns a chrome window even when it is listed first', () => {
    // Why: this is the regression — a permanently-visible notch window landing first in
    // getAllWindows() would otherwise answer "is the app visible?" on the app's behalf,
    // suppressing tray attention and inverting notification focus gating.
    const notch = makeWindow(1)
    makeWindow(2)
    lookup.registerChromeWindow(notch as never)

    expect(lookup.findAppWindow()?.id).toBe(2)
  })

  it('returns null when only a chrome window remains', () => {
    const notch = makeWindow(1)
    lookup.registerChromeWindow(notch as never)

    expect(lookup.findAppWindow()).toBeNull()
  })

  it('stops excluding a chrome window once it closes', () => {
    const notch = makeWindow(1)
    lookup.registerChromeWindow(notch as never)
    expect(lookup.isChromeWindow(notch as never)).toBe(true)

    closedHandlers.get(1)?.()

    expect(lookup.isChromeWindow(notch as never)).toBe(false)
  })

  it('leaves ordinary windows unregistered', () => {
    const plain = makeWindow(1)
    expect(lookup.isChromeWindow(plain as never)).toBe(false)
  })
})
