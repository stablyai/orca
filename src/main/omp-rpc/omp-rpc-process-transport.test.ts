import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnProcess = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess }))
const captureWindowsDescendantSnapshot = vi.hoisted(() => vi.fn())
const terminateIdentifiedWindowsProcessTree = vi.hoisted(() => vi.fn())
const verifyWindowsDescendantSnapshotExit = vi.hoisted(() => vi.fn())
vi.mock('../windows-descendant-exit-verification', () => ({
  captureWindowsDescendantSnapshot,
  terminateIdentifiedWindowsProcessTree,
  verifyWindowsDescendantSnapshotExit
}))
const signalProcessTree = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const forceTerminateProcessTree = vi.hoisted(() => vi.fn().mockResolvedValue(true))
vi.mock('../../shared/child-process/process-tree-termination', () => ({
  signalProcessTree,
  forceTerminateProcessTree
}))

import { OmpRpcProcessTransport } from './omp-rpc-process-transport'

type FakeChild = EventEmitter & {
  pid?: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  kill: ReturnType<typeof vi.fn>
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = vi.fn()
  return child
}

function transportWith() {
  const lines: string[] = []
  const overflows: string[] = []
  const invalidUtf8: string[] = []
  const transport = new OmpRpcProcessTransport(
    { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
    {
      onLine: (line) => lines.push(line),
      onLineOverflow: (message) => overflows.push(message),
      onInvalidUtf8: (message) => invalidUtf8.push(message),
      onStreamError: () => {},
      onExit: () => {}
    }
  )
  return { transport, lines, overflows, invalidUtf8 }
}

describe('OMP RPC process transport stdout framing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    captureWindowsDescendantSnapshot.mockResolvedValue({
      root: { pid: 2468, creationTimeMs: 1 },
      descendants: [],
      unidentifiedCount: 0,
      capturedAtMs: 1
    })
    terminateIdentifiedWindowsProcessTree.mockResolvedValue(true)
    verifyWindowsDescendantSnapshotExit.mockResolvedValue('exited')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps configured wrapper and agent arguments ahead of RPC mode arguments', () => {
    const child = fakeChild()
    spawnProcess.mockReturnValue(child)

    new OmpRpcProcessTransport(
      {
        executablePath: 'env',
        commandArgs: ['omp', '--profile', 'work'],
        cwd: '/work',
        sessionMode: 'session-owning'
      },
      {
        onLine: () => {},
        onLineOverflow: () => {},
        onInvalidUtf8: () => {},
        onStreamError: () => {},
        onExit: () => {}
      }
    )

    expect(spawnProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'env',
        args: ['omp', '--profile', 'work', '--mode', 'rpc']
      })
    )
  })

  it.skipIf(process.platform === 'win32')(
    'starts the POSIX RPC server in a dedicated process group',
    () => {
      const child = fakeChild()
      spawnProcess.mockReturnValue(child)

      transportWith()

      expect(spawnProcess).toHaveBeenCalledWith(expect.objectContaining({ detached: true }))
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not report disposal exit until the POSIX process group is quiescent',
    async () => {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      let finishTreeTermination: ((value: boolean) => void) | undefined
      forceTerminateProcessTree.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            finishTreeTermination = resolve
          })
      )
      const onExit = vi.fn()
      const transport = new OmpRpcProcessTransport(
        { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
        {
          onLine: () => {},
          onLineOverflow: () => {},
          onInvalidUtf8: () => {},
          onStreamError: () => {},
          onExit
        }
      )

      transport.dispose()
      child.emit('close', null, 'SIGTERM')
      await Promise.resolve()

      expect(signalProcessTree).toHaveBeenCalledWith(child, 'SIGTERM')
      expect(forceTerminateProcessTree).toHaveBeenCalledWith(child)
      expect(onExit).not.toHaveBeenCalled()

      finishTreeTermination?.(true)
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(null, 'SIGTERM', undefined))
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not report a natural root close until its POSIX process group is quiescent',
    async () => {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      let finishTreeTermination: ((value: boolean) => void) | undefined
      forceTerminateProcessTree.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => { finishTreeTermination = resolve })
      )
      const onExit = vi.fn()
      new OmpRpcProcessTransport(
        { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
        { onLine: () => {}, onLineOverflow: () => {}, onInvalidUtf8: () => {}, onStreamError: () => {}, onExit }
      )

      child.emit('close', 0, null)
      await Promise.resolve()
      expect(onExit).not.toHaveBeenCalled()
      expect(forceTerminateProcessTree).toHaveBeenCalledWith(child)

      finishTreeTermination?.(true)
      await vi.waitFor(() => expect(onExit).toHaveBeenCalledWith(0, null, undefined))
    }
  )

  it('rejects a session-owning launch command that disables sessions', () => {
    expect(
      () =>
        new OmpRpcProcessTransport(
          {
            executablePath: 'omp',
            commandArgs: ['--no-session'],
            cwd: '/work',
            sessionMode: 'session-owning'
          },
          {
            onLine: () => {},
            onLineOverflow: () => {},
            onInvalidUtf8: () => {},
            onStreamError: () => {},
            onExit: () => {}
          }
        )
    ).toThrow('session-owning OMP RPC spawn cannot include --no-session')
  })

  it('decodes a multi-byte UTF-8 sequence that straddles two stdout chunks', async () => {
    const child = fakeChild()
    spawnProcess.mockReturnValue(child)
    const { lines } = transportWith()
    // Node hands stdout to the reader at arbitrary byte boundaries; a chunk
    // boundary inside "é" (0xC3 0xA9) used to decode as two U+FFFD characters,
    // which JSON.parse accepts silently.
    const frame = Buffer.from(`${JSON.stringify({ type: 'message', text: 'café' })}\n`)
    const split = frame.indexOf(0xc3) + 1

    child.stdout.write(frame.subarray(0, split))
    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.write(frame.subarray(split))
    await new Promise((resolve) => setImmediate(resolve))

    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ type: 'message', text: 'café' })
  })

  it('rejects malformed UTF-8 instead of replacing it inside a frame', async () => {
    const child = fakeChild()
    spawnProcess.mockReturnValue(child)
    const { lines, invalidUtf8 } = transportWith()

    child.stdout.write(Buffer.from([0x7b, 0xc3, 0x28, 0x7d, 0x0a]))
    await new Promise((resolve) => setImmediate(resolve))

    expect(lines).toEqual([])
    expect(invalidUtf8).toEqual(['OMP RPC stdout contained invalid UTF-8'])
  })

  it('faults instead of buffering a line that exceeds the advertised frame cap', async () => {
    const child = fakeChild()
    spawnProcess.mockReturnValue(child)
    const { transport, lines, overflows } = transportWith()
    transport.setMaxLineBytes(16)

    child.stdout.write('x'.repeat(17))
    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.write('\n{"type":"late"}\n')
    await new Promise((resolve) => setImmediate(resolve))

    expect(overflows).toEqual(['OMP RPC stdout line exceeded 16 bytes without a newline'])
    // The listener is detached, so nothing after the overflow is delivered.
    expect(lines).toEqual([])
  })

  it('faults before delivering a newline-terminated line that exceeds the advertised frame cap', async () => {
    const child = fakeChild()
    spawnProcess.mockReturnValue(child)
    const { transport, lines, overflows } = transportWith()
    transport.setMaxLineBytes(16)

    child.stdout.write(`${'x'.repeat(17)}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    expect(lines).toEqual([])
    expect(overflows).toEqual(['OMP RPC stdout line exceeded 16 bytes'])
  })

  it('revalidates and terminates the captured Windows tree without directly killing the root first', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      const { transport } = transportWith()
      transport.dispose()

      await vi.waitFor(() =>
        expect(terminateIdentifiedWindowsProcessTree).toHaveBeenCalledWith(
          { pid: 2468, creationTimeMs: 1 },
          expect.objectContaining({ ownsRoot: expect.any(Function) })
        )
      )
      expect(child.kill).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('kills the owned Windows root by handle when a tree snapshot is unavailable', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      captureWindowsDescendantSnapshot.mockResolvedValue(null)
      const { transport } = transportWith()

      transport.dispose()

      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'))
      expect(terminateIdentifiedWindowsProcessTree).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('does not publish a Windows root close after a snapshotless handle termination', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      captureWindowsDescendantSnapshot.mockResolvedValue(null)
      const onExit = vi.fn()
      const transport = new OmpRpcProcessTransport(
        { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
        {
          onLine: () => {},
          onLineOverflow: () => {},
          onInvalidUtf8: () => {},
          onStreamError: () => {},
          onExit
        }
      )

      transport.dispose()
      await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith('SIGTERM'))
      child.emit('close', null, 'SIGTERM')

      expect(onExit).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('escalates a snapshotless Windows root termination through the owned handle', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      captureWindowsDescendantSnapshot.mockResolvedValue(null)
      const { transport } = transportWith()

      transport.dispose()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('publishes a Windows disposal close that follows verified tree termination', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      const onExit = vi.fn()
      const transport = new OmpRpcProcessTransport(
        { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
        {
          onLine: () => {},
          onLineOverflow: () => {},
          onInvalidUtf8: () => {},
          onStreamError: () => {},
          onExit
        }
      )

      transport.dispose()
      await vi.waitFor(() => expect(verifyWindowsDescendantSnapshotExit).toHaveBeenCalledTimes(1))
      child.emit('close', null, 'SIGTERM')

      expect(onExit).toHaveBeenCalledWith(null, 'SIGTERM', undefined)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('does not report Windows disposal exit when the captured tree remains live after taskkill', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      verifyWindowsDescendantSnapshotExit.mockResolvedValueOnce('live')
      const onExit = vi.fn()
      const transport = new OmpRpcProcessTransport(
        { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
        {
          onLine: () => {},
          onLineOverflow: () => {},
          onInvalidUtf8: () => {},
          onStreamError: () => {},
          onExit
        }
      )

      transport.dispose()
      child.emit('close', null, 'SIGTERM')
      await Promise.resolve()

      expect(onExit).not.toHaveBeenCalled()

      await vi.waitFor(() => expect(verifyWindowsDescendantSnapshotExit).toHaveBeenCalledTimes(1))
      expect(onExit).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('keeps Windows disposal fenced when the root closes after an unverified teardown', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      verifyWindowsDescendantSnapshotExit.mockResolvedValueOnce('live')
      const onExit = vi.fn()
      const transport = new OmpRpcProcessTransport(
        { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
        {
          onLine: () => {},
          onLineOverflow: () => {},
          onInvalidUtf8: () => {},
          onStreamError: () => {},
          onExit
        }
      )

      transport.dispose()
      await vi.waitFor(() => expect(verifyWindowsDescendantSnapshotExit).toHaveBeenCalledTimes(1))
      child.emit('close', null, 'SIGTERM')

      expect(onExit).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('does not publish Windows disposal exit without a verified descendant exit', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      const onExit = vi.fn()
      const transport = new OmpRpcProcessTransport(
        { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
        {
          onLine: () => {},
          onLineOverflow: () => {},
          onInvalidUtf8: () => {},
          onStreamError: () => {},
          onExit
        }
      )
      verifyWindowsDescendantSnapshotExit
        .mockResolvedValueOnce('unverifiable')
        .mockResolvedValueOnce('unverifiable')

      transport.dispose()
      child.emit('close', null, 'SIGTERM')
      await vi.runOnlyPendingTimersAsync()

      expect(child.kill).not.toHaveBeenCalled()
      expect(terminateIdentifiedWindowsProcessTree).toHaveBeenCalledTimes(2)
      expect(onExit).not.toHaveBeenCalled()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('escalates a Windows tree whose SIGTERM verification remains unverifiable', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      verifyWindowsDescendantSnapshotExit.mockResolvedValueOnce('unverifiable')
      verifyWindowsDescendantSnapshotExit.mockResolvedValueOnce('exited')
      const { transport } = transportWith()

      transport.dispose()
      child.emit('close', null, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(0)
      expect(child.kill).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_000)

      expect(child.kill).not.toHaveBeenCalled()
      expect(terminateIdentifiedWindowsProcessTree).toHaveBeenCalledTimes(2)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('retries Windows termination when the force deadline passes during SIGTERM verification', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      child.pid = 2468
      spawnProcess.mockReturnValue(child)
      let finishInitialVerification = (): void => {}
      verifyWindowsDescendantSnapshotExit
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishInitialVerification = () => resolve('live')
            })
        )
        .mockResolvedValueOnce('exited')
      const { transport } = transportWith()

      transport.dispose()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(terminateIdentifiedWindowsProcessTree).toHaveBeenCalledTimes(1)

      finishInitialVerification()
      await vi.advanceTimersByTimeAsync(0)

      expect(terminateIdentifiedWindowsProcessTree).toHaveBeenCalledTimes(2)
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })

  it('does not treat a child error as exit proof before close', () => {
    const child = fakeChild()
    spawnProcess.mockReturnValue(child)
    const onExit = vi.fn()
    new OmpRpcProcessTransport(
      { executablePath: 'omp', cwd: '/work', sessionMode: 'session-less' },
      {
        onLine: () => {},
        onLineOverflow: () => {},
        onInvalidUtf8: () => {},
        onStreamError: () => {},
        onExit
      }
    )

    const failedKill = Object.assign(new Error('kill EPERM'), {
      code: 'EPERM'
    })
    child.emit('error', failedKill)

    expect(onExit).not.toHaveBeenCalled()
    child.emit('close', null, null)
    expect(onExit).toHaveBeenCalledWith(null, null, failedKill)
  })
})
