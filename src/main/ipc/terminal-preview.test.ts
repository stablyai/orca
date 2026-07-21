import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, ipcMainMock, isDashboardPopoutRendererMock } = vi.hoisted(() => {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  return {
    handlers: map,
    ipcMainMock: {
      removeHandler: vi.fn(),
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => map.set(channel, fn)
    },
    isDashboardPopoutRendererMock: vi.fn(() => true)
  }
})

vi.mock('electron', () => ({ ipcMain: ipcMainMock }))
vi.mock('../window/dashboard-popout-window', () => ({
  isDashboardPopoutRenderer: isDashboardPopoutRendererMock
}))

import { registerTerminalPreviewHandlers } from './terminal-preview'

type OutputMeta = { seq?: number; rawLength?: number; transformed?: boolean }
type Listener = (data: string, meta?: OutputMeta) => void

function makeRuntime() {
  const listeners: Listener[] = []
  const unsubscribe = vi.fn()
  const releaseRawView = vi.fn()
  return {
    listeners,
    unsubscribe,
    releaseRawView,
    serializeTerminalBuffer: vi.fn(
      async (): Promise<{ data: string; cols: number; rows: number; seq: number } | null> => ({
        data: 'screen',
        cols: 80,
        rows: 20,
        seq: 5
      })
    ),
    subscribeToTerminalData: vi.fn((_ptyId: string, listener: Listener) => {
      listeners.push(listener)
      return unsubscribe
    }),
    registerRawTerminalViewSubscriber: vi.fn(() => releaseRawView),
    writeTerminalPreviewInput: vi.fn(async () => true)
  }
}

function makeSender(id = 1) {
  const destroyedListeners: (() => void)[] = []
  return {
    id,
    isDestroyed: () => false,
    send: vi.fn(),
    once: (event: string, cb: () => void) => {
      if (event === 'destroyed') {
        destroyedListeners.push(cb)
      }
    },
    fireDestroyed: () => destroyedListeners.forEach((cb) => cb())
  }
}

function eventFor(sender: ReturnType<typeof makeSender>) {
  return { sender } as never
}

describe('registerTerminalPreviewHandlers', () => {
  beforeEach(() => {
    handlers.clear()
    isDashboardPopoutRendererMock.mockReturnValue(true)
  })
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('subscribes before snapshot acquisition and replays only bytes after its sequence', async () => {
    const runtime = makeRuntime()
    let resolveSnapshot!: (snapshot: {
      data: string
      cols: number
      rows: number
      seq: number
    }) => void
    runtime.serializeTerminalBuffer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()

    const resultPromise = handlers.get('terminalPreview:connect')!(eventFor(sender), {
      ptyId: 'p1',
      opts: { scrollbackRows: 24 }
    }) as Promise<unknown>

    expect(runtime.subscribeToTerminalData).toHaveBeenCalledBefore(runtime.serializeTerminalBuffer)
    runtime.listeners[0]!('abc', { seq: 7, rawLength: 3 })
    resolveSnapshot({ data: 'screen', cols: 80, rows: 20, seq: 6 })

    await expect(resultPromise).resolves.toEqual({
      snapshot: { data: 'screen', cols: 80, rows: 20, seq: 6 },
      replay: ['c']
    })
    expect(runtime.registerRawTerminalViewSubscriber).toHaveBeenCalledWith('p1')
  })

  it('coalesces live chunks before crossing IPC and releases them with acknowledgements', async () => {
    vi.useFakeTimers()
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()
    await handlers.get('terminalPreview:connect')!(eventFor(sender), { ptyId: 'p1' })

    runtime.listeners[0]!('a')
    runtime.listeners[0]!('b')
    expect(sender.send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5)
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('terminalPreview:data', {
      type: 'data',
      ptyId: 'p1',
      data: 'ab',
      bytes: 2
    })

    handlers.get('terminalPreview:ack')!(eventFor(sender), { ptyId: 'p1', bytes: 2 })
    expect(sender.send).toHaveBeenCalledTimes(1)
  })

  it('bounds an unresponsive renderer and requests a snapshot resync after prior writes drain', async () => {
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()
    await handlers.get('terminalPreview:connect')!(eventFor(sender), { ptyId: 'p1' })

    const chunk = 'x'.repeat(64 * 1024)
    for (let index = 0; index < 13; index++) {
      runtime.listeners[0]!(chunk)
    }
    const dataSends = sender.send.mock.calls.filter(([, payload]) => payload.type === 'data')
    expect(dataSends).toHaveLength(8)

    for (let index = 0; index < 8; index++) {
      handlers.get('terminalPreview:ack')!(eventFor(sender), {
        ptyId: 'p1',
        bytes: 64 * 1024
      })
    }
    expect(sender.send).toHaveBeenLastCalledWith('terminalPreview:data', {
      type: 'resync',
      ptyId: 'p1'
    })
  })

  it('never overshoots the in-flight byte budget with partial batches', async () => {
    vi.useFakeTimers()
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()
    await handlers.get('terminalPreview:connect')!(eventFor(sender), { ptyId: 'p1' })

    const fullChunk = 'x'.repeat(64 * 1024)
    for (let index = 0; index < 7; index++) {
      runtime.listeners[0]!(fullChunk)
    }
    runtime.listeners[0]!('a'.repeat(40 * 1024))
    await vi.advanceTimersByTimeAsync(5)
    runtime.listeners[0]!('b'.repeat(40 * 1024))
    await vi.advanceTimersByTimeAsync(5)
    expect(sender.send).toHaveBeenCalledTimes(8)

    handlers.get('terminalPreview:ack')!(eventFor(sender), {
      ptyId: 'p1',
      bytes: 64 * 1024
    })
    expect(sender.send).toHaveBeenCalledTimes(9)
  })

  it('fails safe to another resync when output overflows both snapshot captures', async () => {
    const runtime = makeRuntime()
    const snapshotResolvers: ((snapshot: {
      data: string
      cols: number
      rows: number
      seq: number
    }) => void)[] = []
    runtime.serializeTerminalBuffer.mockImplementation(
      () =>
        new Promise((resolve) => {
          snapshotResolvers.push(resolve)
        })
    )
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()

    const resultPromise = handlers.get('terminalPreview:connect')!(eventFor(sender), {
      ptyId: 'p1'
    }) as Promise<unknown>
    const chunk = 'x'.repeat(64 * 1024)
    for (let index = 0; index < 5; index++) {
      runtime.listeners[0]!(chunk)
    }
    snapshotResolvers[0]!({ data: 'first', cols: 80, rows: 20, seq: 1 })
    await vi.waitFor(() => expect(snapshotResolvers).toHaveLength(2))
    for (let index = 0; index < 5; index++) {
      runtime.listeners[0]!(chunk)
    }
    snapshotResolvers[1]!({ data: 'second', cols: 80, rows: 20, seq: 2 })

    await expect(resultPromise).resolves.toEqual({
      snapshot: { data: 'second', cols: 80, rows: 20, seq: 2 },
      replay: [],
      resyncRequired: true
    })
    runtime.listeners[0]!('held until reconnect')
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('releases output and raw-view presence on unsubscribe and sender destruction', async () => {
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()
    await handlers.get('terminalPreview:connect')!(eventFor(sender), { ptyId: 'p1' })
    handlers.get('terminalPreview:unsubscribe')!(eventFor(sender), { ptyId: 'p1' })
    expect(runtime.unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtime.releaseRawView).toHaveBeenCalledTimes(1)

    await handlers.get('terminalPreview:connect')!(eventFor(sender), { ptyId: 'p2' })
    sender.fireDestroyed()
    expect(runtime.unsubscribe).toHaveBeenCalledTimes(2)
    expect(runtime.releaseRawView).toHaveBeenCalledTimes(2)
  })

  it('releases output and raw-view presence when no snapshot exists', async () => {
    const runtime = makeRuntime()
    runtime.serializeTerminalBuffer.mockResolvedValueOnce(null)
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()

    await expect(
      handlers.get('terminalPreview:connect')!(eventFor(sender), { ptyId: 'missing' })
    ).resolves.toEqual({ snapshot: null, replay: [] })
    expect(runtime.unsubscribe).toHaveBeenCalledTimes(1)
    expect(runtime.releaseRawView).toHaveBeenCalledTimes(1)
  })

  it('rejects non-dashboard senders on every preview channel', async () => {
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()
    isDashboardPopoutRendererMock.mockReturnValue(false)

    await expect(
      handlers.get('terminalPreview:connect')!(eventFor(sender), { ptyId: 'p1' })
    ).resolves.toEqual({ snapshot: null, replay: [] })
    await expect(
      handlers.get('terminalPreview:input')!(eventFor(sender), { ptyId: 'p1', data: 'x' })
    ).resolves.toBe(false)
    handlers.get('terminalPreview:ack')!(eventFor(sender), { ptyId: 'p1', bytes: 1 })
    handlers.get('terminalPreview:unsubscribe')!(eventFor(sender), { ptyId: 'p1' })

    expect(runtime.serializeTerminalBuffer).not.toHaveBeenCalled()
    expect(runtime.subscribeToTerminalData).not.toHaveBeenCalled()
    expect(runtime.writeTerminalPreviewInput).not.toHaveBeenCalled()
  })

  it('validates input before routing it to the runtime', async () => {
    const runtime = makeRuntime()
    registerTerminalPreviewHandlers(runtime as never)
    const sender = makeSender()

    await expect(
      handlers.get('terminalPreview:input')!(eventFor(sender), { ptyId: 'p1', data: 'ls\r' })
    ).resolves.toBe(true)
    expect(runtime.writeTerminalPreviewInput).toHaveBeenCalledWith('p1', 'ls\r')

    await expect(
      handlers.get('terminalPreview:input')!(eventFor(sender), { ptyId: '', data: 'x' })
    ).resolves.toBe(false)
    await expect(
      handlers.get('terminalPreview:input')!(eventFor(sender), {
        ptyId: 'x'.repeat(4097),
        data: 'x'
      })
    ).resolves.toBe(false)
    expect(runtime.writeTerminalPreviewInput).toHaveBeenCalledTimes(1)
  })
})
