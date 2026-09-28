/*
 * Coverage for the FORKING console-attachment reader.
 *
 * These assertions moved here with the code when the job-object reader took
 * over the polling path (#16419). They cover the module that caused #10857 --
 * the bounded timeout, the single kill, spawn errors, malformed messages and
 * helper-pid removal -- so none of it is left untested just because the file
 * it used to live in now answers a different question.
 */
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const { runtimeMock, spawnMock, versionMock } = vi.hoisted(() => ({
  runtimeMock: vi.fn(),
  spawnMock: vi.fn(),
  versionMock: vi.fn(() => 'version-one')
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({
    getAppPath: () => '/app',
    getVersion: versionMock,
    onWillQuit: vi.fn()
  })
}))
vi.mock('../daemon/daemon-bun-runtime', () => ({ resolveDesktopDaemonBunRuntime: runtimeMock }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: spawnMock }))
beforeEach(() => {
  runtimeMock.mockReset()
  spawnMock.mockReset()
  versionMock.mockReturnValue('version-one')
})
import { readWindowsConsoleAttachedProcessIds } from './windows-console-attached-processes'

function forkWith(event: 'message' | 'error' | 'none', value?: unknown, pid?: number) {
  const child = new EventEmitter() as EventEmitter & {
    kill: ReturnType<typeof vi.fn>
    pid?: number
  }
  child.kill = vi.fn()
  if (pid !== undefined) {
    child.pid = pid
  }
  const forkProcess = vi.fn(() => {
    queueMicrotask(() => {
      if (event === 'message') {
        child.emit('message', { consoleProcessList: value })
      } else if (event === 'error') {
        child.emit('error', new Error('spawn failed'))
      }
    })
    return child
  })
  return { child, forkProcess: forkProcess as never }
}

describe('readWindowsConsoleAttachedProcessIds', () => {
  it('uses the bundled PTY worker console mode under Bun', async () => {
    vi.stubGlobal('process', { ...process, versions: { ...process.versions, bun: '1.4.2' } })
    try {
      const { forkProcess } = forkWith('message', [999, 101], 999)
      await expect(readWindowsConsoleAttachedProcessIds(101, { forkProcess })).resolves.toEqual(
        new Set([101])
      )
      expect(forkProcess).toHaveBeenCalledWith(
        expect.stringMatching(/windows-bun-pty-gate-entry\.js$/),
        ['--console-process-list', '101']
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('returns exact console membership from the fixed Bun helper', async () => {
    const { forkProcess } = forkWith('message', [999, 101, 202, 303], 999)

    await expect(
      readWindowsConsoleAttachedProcessIds(101, {
        forkProcess,
        resolveAgentPath: () => '/fixed/windows-bun-pty-gate-entry.js'
      })
    ).resolves.toEqual(new Set([101, 202, 303]))
    expect(forkProcess).toHaveBeenCalledWith('/fixed/windows-bun-pty-gate-entry.js', [
      '--console-process-list',
      '101'
    ])
  })

  it.each([
    ['root-only failure fallback', [101], 999],
    ['malformed response', [999, 101, '202'], 999],
    ['missing PTY root', [999, 202, 303], 999],
    ['missing helper pid', [101, 202], 999],
    ['unavailable helper pid', [101, 202], undefined]
  ])('fails closed for %s', async (_label, processIds, helperPid) => {
    const { forkProcess } = forkWith('message', processIds, helperPid)
    await expect(readWindowsConsoleAttachedProcessIds(101, { forkProcess })).resolves.toBeNull()
  })

  it('returns root-only membership when only the helper and shell are attached', async () => {
    const { forkProcess } = forkWith('message', [999, 101], 999)
    await expect(readWindowsConsoleAttachedProcessIds(101, { forkProcess })).resolves.toEqual(
      new Set([101])
    )
  })

  it('reports membership excluding the helper when a real child is attached', async () => {
    const { forkProcess } = forkWith('message', [999, 101, 202], 999)
    await expect(readWindowsConsoleAttachedProcessIds(101, { forkProcess })).resolves.toEqual(
      new Set([101, 202])
    )
  })

  it('handles helper spawn errors without an unhandled child error', async () => {
    const { forkProcess } = forkWith('error')
    await expect(readWindowsConsoleAttachedProcessIds(101, { forkProcess })).resolves.toBeNull()
  })

  it('kills a silent helper at the bounded timeout', async () => {
    vi.useFakeTimers()
    try {
      const { child, forkProcess } = forkWith('none')
      const result = readWindowsConsoleAttachedProcessIds(101, { forkProcess, timeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toBeNull()
      expect(child.kill).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns unknown when killing a timed-out helper throws', async () => {
    vi.useFakeTimers()
    try {
      const { child, forkProcess } = forkWith('none')
      child.kill.mockImplementation(() => {
        throw new Error('access denied')
      })
      const result = readWindowsConsoleAttachedProcessIds(101, { forkProcess, timeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toBeNull()
      child.emit('exit', 1)
      expect(child.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('absorbs an asynchronous kill error after timeout settlement', async () => {
    vi.useFakeTimers()
    try {
      const { child, forkProcess } = forkWith('none')
      child.kill.mockImplementation(() => {
        queueMicrotask(() => child.emit('error', new Error('kill failed')))
      })
      const result = readWindowsConsoleAttachedProcessIds(101, { forkProcess, timeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toBeNull()
      expect(child.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

it('uses bundled Bun rather than the Electron executable for console attachment', async () => {
  const { child, forkProcess } = forkWith('message', [101, 999], 999)
  runtimeMock.mockResolvedValue({
    execPath: '/durable/bun-runtime.exe',
    entryPath: '/durable/daemon-entry.js'
  })
  spawnMock.mockImplementation(forkProcess)
  await expect(readWindowsConsoleAttachedProcessIds(101)).resolves.toEqual(new Set([101]))
  expect(spawnMock).toHaveBeenCalledWith(
    expect.objectContaining({
      program: '/durable/bun-runtime.exe',
      args: [
        '--no-env-file',
        '--config=NUL',
        '--no-install',
        '/durable/windows-bun-pty-gate-entry.js',
        '--console-process-list',
        '101'
      ]
    })
  )
  expect(child.kill).not.toHaveBeenCalled()
  await expect(readWindowsConsoleAttachedProcessIds(101)).resolves.toEqual(new Set([101]))
  expect(runtimeMock).toHaveBeenCalledTimes(1)
})

it('does not start a console helper after runtime resolution exceeds its budget', async () => {
  vi.useFakeTimers()
  try {
    let resolve!: (value: { execPath: string; entryPath: string }) => void
    runtimeMock.mockReturnValue(
      new Promise((done) => {
        resolve = done
      })
    )
    vi.resetModules()
    const { readWindowsConsoleAttachedProcessIds: readFresh } =
      await import('./windows-console-attached-processes')
    const pending = readFresh(101, { timeoutMs: 10 })
    await vi.advanceTimersByTimeAsync(10)
    await expect(pending).resolves.toBeNull()
    resolve({ execPath: '/late/bun', entryPath: '/late/daemon-entry.js' })
    await vi.advanceTimersByTimeAsync(1)
    expect(spawnMock).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('coalesces concurrent verification and refreshes when the installed version changes', async () => {
  vi.resetModules()
  const { readWindowsConsoleAttachedProcessIds: readFresh } =
    await import('./windows-console-attached-processes')
  vi.stubGlobal('process', { ...process, versions: { ...process.versions, electron: '43.7.0' } })
  try {
    let finish!: (runtime: { execPath: string; entryPath: string }) => void
    runtimeMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    spawnMock.mockImplementation(() => {
      const { child } = forkWith('none', undefined, 999)
      queueMicrotask(() => child.emit('message', { consoleProcessList: [101, 999] }))
      return child
    })
    const first = readFresh(101)
    const second = readFresh(101)
    expect(runtimeMock).toHaveBeenCalledTimes(1)
    finish({ execPath: '/v1/bun-runtime.exe', entryPath: '/v1/daemon-entry.js' })
    await expect(first).resolves.toEqual(new Set([101]))
    await expect(second).resolves.toEqual(new Set([101]))
    versionMock.mockReturnValue('version-two')
    runtimeMock.mockResolvedValue({
      execPath: '/v2/bun-runtime.exe',
      entryPath: '/v2/daemon-entry.js'
    })
    await expect(readFresh(101)).resolves.toEqual(new Set([101]))
    expect(runtimeMock).toHaveBeenCalledTimes(2)
    expect(spawnMock.mock.lastCall?.[0].program).toBe('/v2/bun-runtime.exe')
  } finally {
    vi.unstubAllGlobals()
  }
})
