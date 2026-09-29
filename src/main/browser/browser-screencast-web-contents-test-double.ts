import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

export type MockScreencastDebugger = EventEmitter & {
  isAttached: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
}

export type MockScreencastWebContents = {
  isDestroyed: ReturnType<typeof vi.fn>
  debugger: MockScreencastDebugger
}

/** A webContents whose debugger records every CDP command and replays events on demand. */
export function createMockScreencastWebContents(): MockScreencastWebContents {
  let attached = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the four fields are assigned on the next lines, before the value escapes.
  const dbg = new EventEmitter() as MockScreencastDebugger
  dbg.isAttached = vi.fn(() => attached)
  dbg.attach = vi.fn(() => {
    attached = true
  })
  dbg.detach = vi.fn(() => {
    attached = false
  })
  dbg.sendCommand = vi.fn(async () => ({}))

  return {
    isDestroyed: vi.fn(() => false),
    debugger: dbg
  }
}
