import { beforeEach, describe, expect, it, vi } from 'vitest'
import { broadcastToOrcaWindows } from './orca-window-broadcast'
import { orcaWindowManager } from './orca-window-manager'

function createWindow(id: number, send = vi.fn()) {
  return {
    id,
    isDestroyed: () => false,
    webContents: {
      id: id + 100,
      isDestroyed: () => false,
      getType: () => 'window' as const,
      send
    }
  }
}

describe('Orca window broadcast', () => {
  beforeEach(() => {
    for (const window of orcaWindowManager.getAllWindows()) {
      orcaWindowManager.remove(window.id)
    }
  })

  it('isolates a failed renderer send and reaches later windows once', () => {
    const failing = createWindow(
      1,
      vi.fn(() => {
        throw new Error('frame unavailable')
      })
    )
    const live = createWindow(2)
    orcaWindowManager.register(failing as never, 'control')
    orcaWindowManager.register(live as never, 'secondary')

    expect(() => broadcastToOrcaWindows(() => failing as never, 'repos:changed')).not.toThrow()
    expect(failing.webContents.send).toHaveBeenCalledOnce()
    expect(live.webContents.send).toHaveBeenCalledExactlyOnceWith('repos:changed')
  })
})
