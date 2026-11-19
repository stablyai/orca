import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyIpcSession, type PtyRendererDelivery } from '../session'
import { acceptPtyDataForRenderer } from './accept'
import {
  clearHiddenRendererPtyDeliveryState,
  markHiddenRendererPty
} from './pty-hidden-delivery-gate'
import { updateHiddenRendererPtyClaim } from './hidden-transition'
import { wirePtyIpcSession } from './wire-session'
import { rendererVisibilityKnownPtys } from './visibility-state'

const PTY_ID = 'wt-1@@session-1'

function rendererWindow(send: PtyRendererDelivery['webContents']['send']): PtyRendererDelivery {
  return {
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: { id: 1, isDestroyed: () => false, send, on: vi.fn(), removeListener: vi.fn() }
  }
}

describe('hidden PTY output activity', () => {
  afterEach(() => {
    clearHiddenRendererPtyDeliveryState(PTY_ID)
    rendererVisibilityKnownPtys.delete(PTY_ID)
    vi.useRealTimers()
  })

  it('tells the renderer a hidden pane printed output that the delivery gate dropped', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const session = createPtyIpcSession({ mainWindow: rendererWindow(send) })
    markHiddenRendererPty(PTY_ID)

    acceptPtyDataForRenderer(session, { id: PTY_ID, data: 'user@host repo % ' }, undefined)

    vi.runOnlyPendingTimers()

    expect(send).toHaveBeenCalledWith('pty:hiddenOutputActivity', { ids: [PTY_ID] })
    expect(send).not.toHaveBeenCalledWith('pty:data', expect.anything())
  })

  it('keeps the ordered byte stream for a hidden pane retaining graphics', () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const session = createPtyIpcSession({ mainWindow: rendererWindow(send) })
    wirePtyIpcSession(session)
    session.rendererPtyDispatcherReady = true
    rendererVisibilityKnownPtys.add(PTY_ID)
    updateHiddenRendererPtyClaim(session, { id: PTY_ID, hidden: true, retainGraphics: true })

    acceptPtyDataForRenderer(session, { id: PTY_ID, data: 'hidden output\r\n' }, 15)
    vi.runOnlyPendingTimers()

    expect(send).toHaveBeenCalledWith(
      'pty:data',
      expect.objectContaining({ id: PTY_ID, data: 'hidden output\r\n', seq: 15, background: true })
    )
  })
})
