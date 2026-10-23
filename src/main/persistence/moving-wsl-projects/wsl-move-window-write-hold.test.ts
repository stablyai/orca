import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dropUnusedWslMoveWindowWriteHold,
  holdWslMoveWindowWrites,
  isWslMoveWindowWriteHeld,
  reloadWslMoveWindowWithWritesHeld,
  setWslMoveReloadableWindow
} from './wsl-move-window-write-hold'

function fakeWindow() {
  const page = { loaded: () => {}, unloadAllowed: false }
  const window = {
    isDestroyed: vi.fn(() => false),
    reload: vi.fn(),
    allowUnload: () => {
      page.unloadAllowed = true
      return () => {
        page.unloadAllowed = false
      }
    },
    onLoadedOrGone: (listener: () => void) => {
      page.loaded = listener
      return () => {}
    }
  }
  setWslMoveReloadableWindow(() => window)
  return { window, page }
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  dropUnusedWslMoveWindowWriteHold()
  setWslMoveReloadableWindow(() => null)
})

describe('WSL move window write hold', () => {
  it('holds nothing without a window', () => {
    holdWslMoveWindowWrites()
    expect(isWslMoveWindowWriteHeld()).toBe(false)
  })

  it("holds the window's saves until its reloaded page has loaded, past any unload veto", async () => {
    const { window, page } = fakeWindow()
    holdWslMoveWindowWrites()
    holdWslMoveWindowWrites()
    expect(isWslMoveWindowWriteHeld()).toBe(true)

    reloadWslMoveWindowWithWritesHeld()
    reloadWslMoveWindowWithWritesHeld()
    expect(page.unloadAllowed).toBe(true)
    await nextTurn()
    expect(window.reload).toHaveBeenCalledOnce()
    expect(isWslMoveWindowWriteHeld()).toBe(true)

    page.loaded()
    expect(isWslMoveWindowWriteHeld()).toBe(false)
    // A later veto (a real quit with unsaved files) is the page's again.
    expect(page.unloadAllowed).toBe(false)
  })

  it('reloads nothing when nothing was held', async () => {
    const { window } = fakeWindow()
    reloadWslMoveWindowWithWritesHeld()
    await nextTurn()
    expect(window.reload).not.toHaveBeenCalled()
  })

  it('lets the saves resume unreloaded when the move ended short of its rewrite', async () => {
    const { window } = fakeWindow()
    holdWslMoveWindowWrites()
    dropUnusedWslMoveWindowWriteHold()
    expect(isWslMoveWindowWriteHeld()).toBe(false)
    reloadWslMoveWindowWithWritesHeld()
    await nextTurn()
    expect(window.reload).not.toHaveBeenCalled()
  })

  it('keeps a hold whose reload is already under way', async () => {
    const { page } = fakeWindow()
    holdWslMoveWindowWrites()
    reloadWslMoveWindowWithWritesHeld()
    dropUnusedWslMoveWindowWriteHold()
    expect(isWslMoveWindowWriteHeld()).toBe(true)
    await nextTurn()
    page.loaded()
  })
})
