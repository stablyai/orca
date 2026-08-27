import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { PTY_STARTUP_INGRESS_VERSION } from '../shared/pty-startup-ingress'

const { mockPtySpawn, mockPtyInstance, mockCreateShellPromptReadinessProbe } = vi.hoisted(() => ({
  mockPtySpawn: vi.fn(),
  mockCreateShellPromptReadinessProbe: vi.fn(),
  mockPtyInstance: {
    // Why: attach now proves the backing pid is alive before replaying, so the
    // default managed PTY must report a live pid. Reuse the test runner's own
    // pid — always alive — so unrelated attach tests are not seen as dead.
    pid: process.pid,
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    clear: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn()
  }
}))

vi.mock('node-pty', () => ({
  spawn: mockPtySpawn
}))

vi.mock('../main/pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: vi.fn((_pid: number, fallback: () => void) => fallback())
}))

vi.mock('../main/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: mockCreateShellPromptReadinessProbe
}))

import { PtyHandler } from './pty-handler'
import { RelayDispatcher } from './dispatcher'
import { encodeJsonRpcFrame } from './protocol'
import { beginPtyHandlerTest, endPtyHandlerTest } from './pty-handler-test-harness'
import type { MockDispatcher } from './pty-handler-test-harness'

describe('PtyHandler', () => {
  let dispatcher: MockDispatcher
  let handler: PtyHandler
  let originalPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    ;({ dispatcher, handler, originalPlatform } = beginPtyHandlerTest({
      mockPtySpawn,
      mockPtyInstance,
      mockCreateShellPromptReadinessProbe
    }))
  })

  afterEach(async () => {
    await endPtyHandlerTest(handler, originalPlatform)
  })

  it('pauses native output at the producer hard water and resumes after retained writes settle', async () => {
    let onData: ((data: string) => void) | undefined
    const pause = vi.fn()
    const resume = vi.fn()
    mockPtySpawn.mockReturnValueOnce({
      ...mockPtyInstance,
      pause,
      resume,
      onData: vi.fn((callback: (data: string) => void) => {
        onData = callback
      })
    })
    const writeCallbacks: (() => void)[] = []
    let writableLength = 0
    const boundedDispatcher = new RelayDispatcher(
      (data, settle) => {
        writableLength += data.length
        writeCallbacks.push(() => {
          writableLength -= data.length
          settle({ ok: true })
        })
        return true
      },
      {
        supportsWriteCallback: true,
        writableLength: () => writableLength,
        writableHighWaterMark: () => 4 * 1024 * 1024
      }
    )
    const boundedHandler = new PtyHandler(boundedDispatcher)
    try {
      boundedDispatcher.feed(
        encodeJsonRpcFrame({ jsonrpc: '2.0', id: 1, method: 'pty.spawn', params: {} }, 1, 0)
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(onData).toBeTypeOf('function')

      onData?.('x'.repeat(1536 * 1024))
      expect(pause).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(300)

      expect(writeCallbacks.length).toBeGreaterThan(50)
      expect(resume).not.toHaveBeenCalled()
      for (const settle of writeCallbacks.splice(0)) {
        settle()
      }
      await vi.advanceTimersByTimeAsync(0)
      expect(resume).toHaveBeenCalledTimes(1)
    } finally {
      await boundedHandler.dispose({ waitForPhysicalExit: false }).catch(() => {})
      boundedDispatcher.dispose()
    }
  })

  it('forwards data from PTY to dispatcher notifications', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    expect(dataCallback).toBeDefined()

    dataCallback!('hello world')
    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello world' })
  })

  it('consumes capable startup queries before relay replay and fanout', async () => {
    let dataCallback: ((data: string) => void) | undefined
    const term = {
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    }
    mockPtySpawn.mockReturnValue(term)
    await dispatcher.callRequest('pty.spawn', {
      startupIngressVersion: PTY_STARTUP_INGRESS_VERSION,
      startupIngress: {
        colors: { foreground: '#2e3434', background: '#ffffff' },
        deadlineMs: 5_000
      }
    })

    const query = '\x1b]10;?\x07'
    dataCallback!(query)
    dataCallback!('prompt')
    vi.advanceTimersByTime(8)

    expect(term.write).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
      id: 'pty-1',
      data: '',
      rawLength: query.length,
      seq: query.length,
      transformed: true
    })
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'prompt' })
    await expect(
      dispatcher.callRequest('pty.attach', {
        id: 'pty-1',
        suppressReplayNotification: true
      })
    ).resolves.toEqual({ replay: 'prompt', incarnationId: expect.any(String) })
  })

  it('does not carry transformed raw length into the next plain pending entry', async () => {
    await handler.dispose({ waitForPhysicalExit: false })
    const admitted: Record<string, unknown>[] = []
    let hasCapacity = false
    const tryNotifyPtyData = vi.fn((params: Record<string, unknown>) => {
      if (hasCapacity) {
        admitted.push(params)
      }
      return hasCapacity
    })
    Object.assign(dispatcher, {
      onLegacyPtyCapacity: vi.fn(() => vi.fn()),
      tryNotifyPtyData,
      tryNotifyPtyExit: vi.fn(() => true),
      legacyRetentionBelowLowWater: true
    })
    handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((callback: (data: string) => void) => {
        dataCallback = callback
      }),
      onExit: vi.fn()
    })
    await dispatcher.callRequest('pty.spawn', {
      startupIngressVersion: PTY_STARTUP_INGRESS_VERSION,
      startupIngress: {
        colors: { foreground: '#2e3434', background: '#ffffff' },
        deadlineMs: 5_000
      }
    })

    const query = '\x1b]10;?\x07'
    dataCallback?.(query)
    dataCallback?.('fresh')
    hasCapacity = true
    await vi.runAllTimersAsync()

    expect(tryNotifyPtyData).toHaveBeenCalledTimes(3)
    expect(admitted).toEqual([
      {
        id: 'pty-1',
        data: '',
        rawLength: query.length,
        seq: query.length,
        transformed: true
      },
      { id: 'pty-1', data: 'fresh' }
    ])
  })

  describe('legacy flush retry with a memoized source chunk', () => {
    let capacityListener: (() => void) | undefined
    let hasCapacity: boolean
    let maxChars: number
    let admitted: Record<string, unknown>[]
    let dataCallback: ((data: string) => void) | undefined

    async function setupRetryHarness(spawnParams: Record<string, unknown> = {}): Promise<void> {
      await handler.dispose({ waitForPhysicalExit: false })
      capacityListener = undefined
      hasCapacity = false
      admitted = []
      Object.assign(dispatcher, {
        onLegacyPtyCapacity: vi.fn((listener: () => void) => {
          capacityListener = listener
          return vi.fn()
        }),
        tryNotifyPtyData: vi.fn((params: Record<string, unknown>) => {
          if (hasCapacity) {
            admitted.push(params)
          }
          return hasCapacity
        }),
        tryNotifyPtyExit: vi.fn(() => true),
        legacyRetentionBelowLowWater: true,
        // Clamped like the real dispatcher: never more than min(data.length, limit).
        maxLegacyPtyDataChars: vi.fn((_params: unknown, data: string, limit?: number) =>
          Math.min(maxChars, data.length, limit ?? data.length)
        )
      })
      handler = new PtyHandler(dispatcher as unknown as RelayDispatcher)
      dataCallback = undefined
      mockPtySpawn.mockReturnValue({
        ...mockPtyInstance,
        onData: vi.fn((callback: (data: string) => void) => {
          dataCallback = callback
        }),
        onExit: vi.fn()
      })
      await dispatcher.callRequest('pty.spawn', spawnParams)
      expect(dataCallback).toBeDefined()
    }

    it('resends the memo verbatim and keeps the coalesced tail when capacity grows', async () => {
      maxChars = 5_000
      await setupRetryHarness()
      dataCallback!('a'.repeat(20_000))
      await vi.advanceTimersByTimeAsync(8)
      // Why before restoring capacity: the failed batch made zero writes so no flush is
      // rescheduled; this enqueue re-arms the timer.
      dataCallback!('b'.repeat(10))
      hasCapacity = true
      maxChars = 16_384
      await vi.runAllTimersAsync()

      expect(admitted.map((frame) => frame.data).join('')).toBe('a'.repeat(20_000) + 'b'.repeat(10))
      expect((admitted[0].data as string).length).toBe(5_000)
      // Why: remainder frames must not leak transformed/rawLength/seq keys.
      expect(admitted[1]).toStrictEqual({ id: 'pty-1', data: expect.any(String) })
    })

    it('keeps a tail appended after a failed flush under constant capacity', async () => {
      maxChars = 16_384
      await setupRetryHarness()
      dataCallback!('a'.repeat(5_000))
      await vi.advanceTimersByTimeAsync(8)
      dataCallback!('b'.repeat(10))
      hasCapacity = true
      await vi.runAllTimersAsync()

      expect(admitted.map((frame) => frame.data).join('')).toBe('a'.repeat(5_000) + 'b'.repeat(10))
      expect(admitted[1].data).toBe('b'.repeat(10))
    })

    it('does not duplicate memoized chars when capacity shrinks before the retry', async () => {
      maxChars = 16_384
      await setupRetryHarness()
      dataCallback!('a'.repeat(20_000))
      await vi.advanceTimersByTimeAsync(8)
      maxChars = 5_000
      hasCapacity = true
      // Why: nothing else re-arms the flush timer after a zero-write batch.
      capacityListener!()
      await vi.runAllTimersAsync()

      expect(admitted.map((frame) => frame.data).join('')).toBe('a'.repeat(20_000))
      expect((admitted[0].data as string).length).toBe(16_384)
      expect((admitted[1].data as string).length).toBe(3_616)
    })

    it('retains a coalesced transformed raw advance behind a memoized source-only chunk', async () => {
      maxChars = 16_384
      await setupRetryHarness({
        startupIngressVersion: PTY_STARTUP_INGRESS_VERSION,
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })
      // First answered query: direct publish fails, entry queued without a memo.
      dataCallback!('\x1b]10;?\x07')
      // Capacity event while still blocked: the flush fails and memoizes the source-only chunk.
      capacityListener!()
      await vi.advanceTimersByTimeAsync(0)
      // Second answered query coalesces into the memoized transformed head.
      dataCallback!('\x1b]11;?\x07')
      hasCapacity = true
      capacityListener!()
      await vi.runAllTimersAsync()

      expect(admitted).toEqual([
        { id: 'pty-1', data: '', rawLength: 7, seq: 7, transformed: true },
        { id: 'pty-1', data: '', rawLength: 7, seq: 14, transformed: true }
      ])
    })
  })

  it('leaves startup queries untouched for an unsupported relay capability version', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      await dispatcher.callRequest('pty.spawn', {
        startupIngressVersion: PTY_STARTUP_INGRESS_VERSION - 1,
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })

      const query = '\x1b]10;?\x07'
      dataCallback!(query)
      vi.advanceTimersByTime(8)

      expect(term.write).not.toHaveBeenCalled()
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: query })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('consumes a color query at a native Windows SSH relay owner', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      await dispatcher.callRequest('pty.spawn', { shellOverride: 'powershell.exe' })

      dataCallback!('\x1b]10;?\x07')
      vi.advanceTimersByTime(8)

      expect(term.write).not.toHaveBeenCalled()
      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: 'pty-1',
        data: '',
        rawLength: '\x1b]10;?\x07'.length,
        seq: '\x1b]10;?\x07'.length,
        transformed: true
      })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('forwards color queries from a POSIX SSH relay owner', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    try {
      let dataCallback: ((data: string) => void) | undefined
      mockPtySpawn.mockReturnValue({
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      })
      await dispatcher.callRequest('pty.spawn', { shellOverride: '/bin/bash' })
      const query = '\x1b]10;?\x07'

      dataCallback!(query)
      vi.advanceTimersByTime(8)

      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: query })
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('keeps renderer color replies for a Windows SSH relay that owns WSL', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      let dataCallback: ((data: string) => void) | undefined
      const term = {
        ...mockPtyInstance,
        onData: vi.fn((cb: (data: string) => void) => {
          dataCallback = cb
        }),
        onExit: vi.fn()
      }
      mockPtySpawn.mockReturnValue(term)
      await dispatcher.callRequest('pty.spawn', {
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })
      const reply = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'

      dataCallback!('\x1b]11;?\x07')
      vi.advanceTimersByTime(8)
      dispatcher.callNotification('pty.data', { id: 'pty-1', data: reply })

      expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
        id: 'pty-1',
        data: '\x1b]11;?\x07'
      })
      expect(term.write).toHaveBeenCalledWith(reply)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('coalesces background PTY output before notifying the client', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dataCallback!('hello ')
    dataCallback!('world')

    expect(dispatcher.notify).not.toHaveBeenCalledWith('pty.data', expect.anything())
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
      id: 'pty-1',
      data: 'hello world'
    })
  })

  it('sends recent-input redraw output immediately', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dispatcher.callNotification('pty.data', { id: 'pty-1', data: 'a' })
    dispatcher.notify.mockClear()

    dataCallback!('\x1b[20;2Hredraw')

    expect(dispatcher.notify).toHaveBeenCalledWith('pty.data', {
      id: 'pty-1',
      data: '\x1b[20;2Hredraw'
    })
    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledTimes(1)
  })

  it('drains large relay PTY output in bounded slices', async () => {
    let dataCallback: ((data: string) => void) | undefined
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      onData: vi.fn((cb: (data: string) => void) => {
        dataCallback = cb
      }),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    const firstChunk = 'x'.repeat(16 * 1024)
    dataCallback!(`${firstChunk}tail`)

    vi.advanceTimersByTime(8)
    expect(dispatcher.notify).toHaveBeenCalledTimes(1)
    expect(dispatcher.notify).toHaveBeenNthCalledWith(1, 'pty.data', {
      id: 'pty-1',
      data: firstChunk
    })

    vi.advanceTimersByTime(1)
    expect(dispatcher.notify).toHaveBeenCalledTimes(2)
    expect(dispatcher.notify).toHaveBeenNthCalledWith(2, 'pty.data', {
      id: 'pty-1',
      data: 'tail'
    })
  })

  it('writes data to PTY via pty.data notification', async () => {
    const mockWrite = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      write: mockWrite,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dispatcher.callNotification('pty.data', { id: 'pty-1', data: 'ls\n' })
    expect(mockWrite).toHaveBeenCalledWith('ls\n')
  })

  it('resizes PTY via pty.resize notification', async () => {
    const mockResize = vi.fn()
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      resize: mockResize,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    await dispatcher.callRequest('pty.spawn', {})
    dispatcher.callNotification('pty.resize', { id: 'pty-1', cols: 120, rows: 40 })
    expect(mockResize).toHaveBeenCalledWith(120, 40)
  })

  it('reports the PTY grid actually applied by node-pty', async () => {
    mockPtySpawn.mockReturnValue({
      ...mockPtyInstance,
      cols: 132,
      rows: 43,
      onData: vi.fn(),
      onExit: vi.fn()
    })

    const spawned = (await dispatcher.callRequest('pty.spawn', {})) as { id: string }

    await expect(dispatcher.callRequest('pty.getSize', { id: spawned.id })).resolves.toEqual({
      cols: 132,
      rows: 43
    })
    await expect(dispatcher.callRequest('pty.getSize', { id: 'missing' })).resolves.toBeNull()
  })
})
