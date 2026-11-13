import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'

const { isDashboardOrFloatingRenderer } = vi.hoisted(() => ({
  isDashboardOrFloatingRenderer: vi.fn((_sender: unknown) => false)
}))

vi.mock('../floating-workspace-window', () => ({ isDashboardOrFloatingRenderer }))

import {
  assertTrustedClipboardSender,
  assertTrustedClipboardTextSender,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-sender-trust'

function eventFrom(id: number): IpcMainInvokeEvent {
  const sender = {
    id,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///floating.html'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trust checks read only these sender fields.
  return { sender } as unknown as IpcMainInvokeEvent
}

describe('clipboard sender trust', () => {
  it('grants the floating window text clipboard access only', () => {
    setTrustedClipboardRendererWebContentsId(17)
    const floating = eventFrom(42)
    isDashboardOrFloatingRenderer.mockImplementation((sender) => sender === floating.sender)

    expect(() => assertTrustedClipboardTextSender(floating)).not.toThrow()
    expect(() => assertTrustedClipboardSender(floating)).toThrow(
      'Unauthorized clipboard IPC sender'
    )
    expect(() => assertTrustedClipboardTextSender(eventFrom(99))).toThrow(
      'Unauthorized clipboard IPC sender'
    )
  })
})
