import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getAllWindowsMock } = vi.hoisted(() => ({
  getAllWindowsMock: vi.fn(() => [])
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: getAllWindowsMock
  }
}))

import type { DetachedTerminalSnapshot } from '../../shared/detached-terminal-window'
import { detachedWindowRegistry } from './detached-window-registry'

type MockWindow = Electron.BrowserWindow & {
  trigger: (event: string) => void
  focus: () => void
  close: () => void
}

function makeWindow(id: number): MockWindow {
  const listeners = new Map<string, (() => void)[]>()
  const win = {
    id,
    webContents: { id: id + 100 },
    isDestroyed: vi.fn(() => false),
    focus: vi.fn(),
    close: vi.fn(() => {
      vi.mocked(win.isDestroyed).mockReturnValue(true)
      win.trigger('closed')
    }),
    on: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return win
    }),
    trigger: (event: string) => {
      for (const handler of listeners.get(event) ?? []) {
        handler()
      }
    }
  } as unknown as MockWindow
  return win
}

function makeSnapshot(ptyIds: string[]): DetachedTerminalSnapshot {
  return { ptyIds } as DetachedTerminalSnapshot
}

describe('detachedWindowRegistry', () => {
  beforeEach(() => {
    getAllWindowsMock.mockReset()
    detachedWindowRegistry
      .getAppWindows()
      .forEach((win) => detachedWindowRegistry.unregisterWindow(win))
  })

  it('focuses an existing detached terminal window for the same worktree tab', () => {
    const win = makeWindow(1)
    const key = { worktreeId: 'worktree-1', tabId: 'tab-1' }

    detachedWindowRegistry.registerDetachedTerminalWindow(key, win, makeSnapshot(['pty-1']))

    expect(detachedWindowRegistry.focusDetachedTerminalWindow(key)).toBe(true)
    expect(win.focus).toHaveBeenCalledTimes(1)
    expect(detachedWindowRegistry.getDetachedTerminalWindow(key)).toBe(win)
  })

  it('unregisters only the detached window when closing it', () => {
    const main = makeWindow(1)
    const detached = makeWindow(2)
    const key = { worktreeId: 'worktree-1', tabId: 'tab-1' }
    detachedWindowRegistry.registerMainWindow(main)
    detachedWindowRegistry.registerDetachedTerminalWindow(key, detached, makeSnapshot(['pty-1']))

    detachedWindowRegistry.closeDetachedTerminalWindow(key)

    expect(detached.close).toHaveBeenCalledTimes(1)
    expect(detachedWindowRegistry.getDetachedTerminalWindow(key)).toBeNull()
    expect(detachedWindowRegistry.getPrimaryAppWindow()).toBe(main)
    expect(detachedWindowRegistry.getAppWindows()).toEqual([main])
  })

  it('returns only registered app windows and excludes raw offscreen BrowserWindows', () => {
    const main = makeWindow(1)
    const detached = makeWindow(2)
    const offscreen = makeWindow(3)
    getAllWindowsMock.mockReturnValue([main, detached, offscreen] as never)

    detachedWindowRegistry.registerMainWindow(main)
    detachedWindowRegistry.registerDetachedTerminalWindow(
      { worktreeId: 'worktree-1', tabId: 'tab-1' },
      detached,
      makeSnapshot(['pty-1'])
    )

    expect(detachedWindowRegistry.getAppWindows()).toEqual([main, detached])
    expect(detachedWindowRegistry.getAppWindows()).not.toContain(offscreen)
  })

  it('stores staged detached terminal snapshots by key', () => {
    const win = makeWindow(1)
    const key = { worktreeId: 'worktree-1', tabId: 'tab-1' }
    const snapshot = makeSnapshot(['pty-1', 'pty-2'])

    detachedWindowRegistry.registerDetachedTerminalWindow(key, win, snapshot)

    expect(detachedWindowRegistry.getDetachedTerminalSnapshot(key)).toBe(snapshot)
  })
})
