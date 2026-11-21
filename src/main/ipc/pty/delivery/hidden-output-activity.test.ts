import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPtyIpcSession, type PtyRendererDelivery } from '../session'
import { acceptPtyDataForRenderer } from './accept'
import {
  clearHiddenRendererPtyDeliveryState,
  markHiddenRendererPty
} from './pty-hidden-delivery-gate'

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
})
