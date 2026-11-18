import type { IpcMainEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPtyHostBindings, type PtyIpcSurface } from '../pty-host-bindings'
import { createPtyIpcSession } from '../session'
import { wirePtyIpcSession } from '../delivery/wire-session'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markRuntimeOwnedHiddenRendererPty,
  recordHiddenRendererPtyDataDrop,
  resetRendererScopedHiddenPtyDeliveryState,
  shouldDropHiddenRendererPtyData
} from '../delivery/pty-hidden-delivery-gate'
import { visibleRendererPtys } from '../delivery/visibility-state'
import { installPtyResizeVisibilityIpc } from './resize-visibility'

const PTY_ID = 'pty-1'
const listeners = new Map<string, Parameters<PtyIpcSurface['on']>[1]>()
const send = vi.fn()
// These handlers ignore their event, and a real IpcMainEvent needs a live WebContents.
const ipcEvent: IpcMainEvent = Object.create(null)

function emit(channel: string, args: unknown): void {
  listeners.get(channel)?.(ipcEvent, args)
}

function unhideMarkers(): unknown[] {
  return send.mock.calls.filter(
    ([channel, payload]) => channel === 'pty:modelRestoreNeeded' && payload.reason === 'unhide'
  )
}

beforeEach(() => {
  setPtyHostBindings({
    ipc: {
      handle: () => {},
      on: (channel, listener) => listeners.set(channel, listener),
      removeHandler: () => {},
      removeAllListeners: (channel) => listeners.delete(channel)
    }
  })
  const session = createPtyIpcSession({
    mainWindow: {
      isDestroyed: () => false,
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { id: 1, isDestroyed: () => false, send, on: vi.fn(), removeListener: vi.fn() }
    }
  })
  wirePtyIpcSession(session)
  installPtyResizeVisibilityIpc(session)
  // Main attached the live session before any pane showed it, then the renderer reloaded.
  markRuntimeOwnedHiddenRendererPty(PTY_ID)
  recordHiddenRendererPtyDataDrop(PTY_ID, 10)
  resetRendererScopedHiddenPtyDeliveryState()
})

afterEach(() => {
  setPtyHostBindings({})
  listeners.clear()
  send.mockReset()
  visibleRendererPtys.clear()
  _resetHiddenRendererPtyDeliveryGateForTest()
})

describe('pty:setRendererPtyVisible', () => {
  it('reveals a main-hidden pty once a pane reports it visible', () => {
    emit('pty:setRendererPtyVisible', { id: PTY_ID, visible: true })

    expect(shouldDropHiddenRendererPtyData(PTY_ID, undefined)).toBe(false)
    expect(unhideMarkers()).toHaveLength(1)
  })

  it("does not resend the visible report's marker on the pane's first-sync release", () => {
    emit('pty:setRendererPtyVisible', { id: PTY_ID, visible: true })
    emit('pty:setHiddenRendererPty', { id: PTY_ID, hidden: false })

    expect(unhideMarkers()).toHaveLength(1)

    emit('pty:setHiddenRendererPty', { id: PTY_ID, hidden: true })
    emit('pty:setHiddenRendererPty', { id: PTY_ID, hidden: false })

    expect(unhideMarkers()).toHaveLength(2)
  })

  it('leaves the reveal to a pane that still holds a hidden claim', () => {
    emit('pty:setHiddenRendererPty', { id: PTY_ID, hidden: true })
    emit('pty:setRendererPtyVisible', { id: PTY_ID, visible: true })

    expect(shouldDropHiddenRendererPtyData(PTY_ID, undefined)).toBe(true)
    expect(unhideMarkers()).toHaveLength(0)

    emit('pty:setHiddenRendererPty', { id: PTY_ID, hidden: false })

    expect(shouldDropHiddenRendererPtyData(PTY_ID, undefined)).toBe(false)
    expect(unhideMarkers()).toHaveLength(1)
  })

  it("drops a reloaded renderer's stale hidden claim", () => {
    emit('pty:setHiddenRendererPty', { id: PTY_ID, hidden: true })
    resetRendererScopedHiddenPtyDeliveryState()
    emit('pty:setRendererPtyVisible', { id: PTY_ID, visible: true })

    expect(shouldDropHiddenRendererPtyData(PTY_ID, undefined)).toBe(false)
    expect(unhideMarkers()).toHaveLength(1)
  })
})
