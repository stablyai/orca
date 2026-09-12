import { describe, expect, it, vi } from 'vitest'
import { createPtyIpcSession } from './pty/session'
import { finalizePtyExitForRenderer } from './pty/delivery/exit'
import { dropOversizedPendingPtyData, pendingDataCapChars } from './pty/delivery/pending'

vi.mock('./pty/provider/registry', () => ({ tryGetProviderForPty: () => null }))

describe('PTY exit warning retirement', () => {
  it('warns once per incarnation and warns again when an exited id is reused', () => {
    const session = createPtyIpcSession({
      mainWindow: { isDestroyed: () => false, webContents: { send: vi.fn() } } as never
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const oversized = { data: 'x'.repeat(pendingDataCapChars(session) + 1) }
      expect(dropOversizedPendingPtyData(session, 'reused', oversized).droppedOutput).toBe(true)
      dropOversizedPendingPtyData(session, 'reused', oversized)
      expect(error).toHaveBeenCalledOnce()
      finalizePtyExitForRenderer(session, { id: 'reused', code: 0 })
      dropOversizedPendingPtyData(session, 'reused', oversized)
      expect(error).toHaveBeenCalledTimes(2)
    } finally {
      error.mockRestore()
    }
  })

  it.each([false, true])('releases ended warning ids with renderer destroyed=%s', (destroyed) => {
    const mainWindow = {
      isDestroyed: () => destroyed,
      webContents: { send: vi.fn() }
    }
    const session = createPtyIpcSession({ mainWindow: mainWindow as never })
    session.pendingDataDropWarnedPtys.add('active')
    for (let index = 0; index < 1_000; index += 1) {
      const id = `retired-${index}`
      session.pendingDataDropWarnedPtys.add(id)
      finalizePtyExitForRenderer(session, { id, code: 0 })
    }
    expect([...session.pendingDataDropWarnedPtys]).toEqual(['active'])
    expect(mainWindow.webContents.send).toHaveBeenCalledTimes(destroyed ? 0 : 1_000)
  })
})
