import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, ipcMainMock } = vi.hoisted(() => {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers: map,
    ipcMainMock: {
      removeHandler: vi.fn(),
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => map.set(channel, fn)
    }
  }
})

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))
vi.mock('../window/dashboard-popout-window', () => ({
  isDashboardPopoutRenderer: () => true
}))

import {
  registerTerminalPreviewHandlers,
  TERMINAL_PREVIEW_MAX_ENTRIES_PER_CONTENTS,
  TERMINAL_PREVIEW_MAX_ENTRIES_TOTAL
} from './terminal-preview'

function makeRuntime() {
  return {
    serializeTerminalBuffer: vi.fn(async () => ({ data: '', cols: 80, rows: 24, seq: 0 })),
    subscribeToTerminalData: vi.fn(() => vi.fn()),
    subscribeToTerminalResize: vi.fn(() => vi.fn()),
    registerRawTerminalViewSubscriber: vi.fn(() => vi.fn()),
    writeTerminalPreviewInput: vi.fn(async () => true),
    updateRemoteDesktopViewer: vi.fn(async () => true),
    unregisterRemoteDesktopViewer: vi.fn(async () => true),
    getTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 }))
  }
}

function makeSender(id: number) {
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn()
  }
}

function eventFor(sender: ReturnType<typeof makeSender>) {
  return { sender } as never
}

describe('terminal preview aggregate admission', () => {
  beforeEach(() => handlers.clear())

  it('bounds output streams per renderer without affecting replacements', async () => {
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender(1)
    const connect = handlers.get('terminalPreview:connect')!

    for (let index = 0; index < TERMINAL_PREVIEW_MAX_ENTRIES_PER_CONTENTS; index += 1) {
      await connect(eventFor(sender), { ptyId: `pty-${index}` })
    }
    await expect(connect(eventFor(sender), { ptyId: 'overflow' })).resolves.toEqual({
      snapshot: null,
      replay: []
    })
    await expect(connect(eventFor(sender), { ptyId: 'pty-0' })).resolves.toMatchObject({
      snapshot: { cols: 80, rows: 24 }
    })
    expect(runtime.subscribeToTerminalData).toHaveBeenCalledTimes(
      TERMINAL_PREVIEW_MAX_ENTRIES_PER_CONTENTS + 1
    )
  })

  it('bounds output streams across renderers', async () => {
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const connect = handlers.get('terminalPreview:connect')!

    for (let index = 0; index < TERMINAL_PREVIEW_MAX_ENTRIES_TOTAL; index += 1) {
      const sender = makeSender(Math.floor(index / TERMINAL_PREVIEW_MAX_ENTRIES_PER_CONTENTS) + 1)
      await connect(eventFor(sender), { ptyId: `pty-${index}` })
    }
    await expect(connect(eventFor(makeSender(99)), { ptyId: 'overflow' })).resolves.toEqual({
      snapshot: null,
      replay: []
    })
    expect(runtime.subscribeToTerminalData).toHaveBeenCalledTimes(
      TERMINAL_PREVIEW_MAX_ENTRIES_TOTAL
    )
  })

  it('bounds independent fit claims per renderer', async () => {
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender(1)
    const fit = handlers.get('terminalPreview:fit')!

    for (let index = 0; index < TERMINAL_PREVIEW_MAX_ENTRIES_PER_CONTENTS; index += 1) {
      await fit(eventFor(sender), { ptyId: `pty-${index}`, cols: 80, rows: 24 })
    }
    await expect(
      fit(eventFor(sender), { ptyId: 'overflow', cols: 80, rows: 24 })
    ).resolves.toBeNull()
    expect(runtime.updateRemoteDesktopViewer).toHaveBeenCalledTimes(
      TERMINAL_PREVIEW_MAX_ENTRIES_PER_CONTENTS
    )
  })
})
