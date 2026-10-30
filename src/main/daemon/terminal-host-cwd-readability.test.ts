import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost } from './terminal-host'
import { validateWorkingDirectoryAsync } from '../providers/working-directory-validation'

const { opendirMock, statMock } = vi.hoisted(() => ({
  opendirMock: vi.fn(),
  statMock: vi.fn()
}))
// TCC directory enumeration can remain pending while a permission sheet is open.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  opendir: opendirMock,
  stat: statMock
}))

vi.mock('../pty-descendant-termination', () => ({ killWithDescendantSweep: vi.fn() }))

const close = vi.fn(async () => {})
const spawnSubprocess = vi.fn(() => createMockSubprocess())

function dirReading(read: () => unknown): { read: () => unknown; close: () => Promise<void> } {
  return { read, close }
}

function failWith(code: string): never {
  throw Object.assign(new Error(code), { code })
}

function stallEnumeration(stage: 'open' | 'read' | 'close') {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const directory = {
    read: async () => {
      if (stage === 'read') {
        await pending
      }
      return null
    },
    close: vi.fn(async () => {
      if (stage === 'close') {
        await pending
      }
    })
  }
  opendirMock.mockImplementation(async () => {
    if (stage === 'open') {
      await pending
    }
    return directory
  })
  return { release, directory }
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 99999,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      setTimeout(() => onExitCb?.(0), 5)
    }),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExitCb?.(137)),
    signal: vi.fn(),
    onData() {},
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn()
  }
}

// Only the daemon can measure its own cwd permissions; other failures must not imply denial.
describe('TerminalHost cwd readability verdict', () => {
  let host: TerminalHost
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    close.mockReset()
    spawnSubprocess.mockClear()
    statMock.mockReset()
    opendirMock.mockReset().mockReturnValue(dirReading(() => ({ name: 'entry' })))
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    host = new TerminalHost({ spawnSubprocess })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await host.dispose()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  const create = (sessionId: string, cwd?: string, signal?: AbortSignal) =>
    host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      ...(cwd ? { cwd } : {}),
      ...(signal ? { cancelSignal: signal, isCanceled: () => signal.aborted } : {}),
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

  it('reports an enumerable cwd as readable, and closes the handle', async () => {
    expect((await create('readable', '/work/repo')).cwdReadableByDaemon).toBe(true)
    expect(opendirMock).toHaveBeenCalledWith('/work/repo')
    expect(close).toHaveBeenCalled()
  })

  it('reports an empty directory as readable', async () => {
    opendirMock.mockReturnValue(dirReading(() => null))
    expect((await create('empty', '/work/empty')).cwdReadableByDaemon).toBe(true)
  })

  it('reports EPERM on open as denied', async () => {
    opendirMock.mockImplementation(() => failWith('EPERM'))
    expect((await create('eperm', '/Users/alice/Documents/repo')).cwdReadableByDaemon).toBe(false)
  })

  it('reports EACCES on the first read as denied, and still closes the handle', async () => {
    opendirMock.mockReturnValue(dirReading(() => failWith('EACCES')))
    expect((await create('eacces', '/Users/alice/Desktop/repo')).cwdReadableByDaemon).toBe(false)
    expect(close).toHaveBeenCalled()
  })

  it('reports a missing cwd as readable — absence is not a permission denial', async () => {
    opendirMock.mockImplementation(() => failWith('ENOENT'))
    expect((await create('enoent', '/definitely/not/a/real/dir')).cwdReadableByDaemon).toBe(true)
  })

  it('reports a non-directory cwd as readable', async () => {
    opendirMock.mockImplementation(() => failWith('ENOTDIR'))
    expect((await create('enotdir', '/work/repo/file.txt')).cwdReadableByDaemon).toBe(true)
  })

  it('reports an unexpected failure as readable — it must not masquerade as denial', async () => {
    opendirMock.mockImplementation(() => {
      throw new TypeError('opendir is not a function')
    })
    expect((await create('unexpected', '/work/repo')).cwdReadableByDaemon).toBe(true)
  })

  it('omits the verdict when no cwd was requested', async () => {
    expect((await create('no-cwd')).cwdReadableByDaemon).toBeUndefined()
    expect(opendirMock).not.toHaveBeenCalled()
  })

  it.each(['linux', 'win32'])('skips TCC enumeration on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
    expect((await create('non-macos', '/work/repo')).cwdReadableByDaemon).toBeUndefined()
    expect(opendirMock).not.toHaveBeenCalled()
  })

  it('keeps native UNC creation within the validation lane while healthy creation proceeds', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    vi.useFakeTimers()
    let release = () => {}
    const unavailable = new Promise<void>((resolve) => {
      release = resolve
    })
    opendirMock.mockImplementation(async () => {
      await unavailable
      return dirReading(() => null)
    })
    const server = '\\\\unreachable-smb\\share'
    let active = 0
    let peak = 0
    statMock.mockImplementation(async (cwd: string) => {
      if (cwd.startsWith(server)) {
        active += 1
        peak = Math.max(peak, active)
        try {
          await unavailable
        } finally {
          active -= 1
        }
      }
      return { isDirectory: () => true }
    })
    await host.dispose()
    host = new TerminalHost({
      spawnSubprocess: async (opts) => {
        if (opts.cwd) {
          await validateWorkingDirectoryAsync(opts.cwd, { signal: opts.cancelSignal })
        }
        return createMockSubprocess()
      }
    })
    const abort = new AbortController()
    const firstPath = `${server}\\first`
    const canceled = create('unc-canceled', firstPath, abort.signal)
    void canceled.catch(() => {})
    const pending = [
      create('unc-second', `${server}\\second`),
      create('unc-queued', `${server}\\third`)
    ]
    try {
      await vi.advanceTimersByTimeAsync(1_100)
      expect(active + opendirMock.mock.calls.length).toBe(2)
      abort.abort()
      await expect(canceled).rejects.toThrow('was canceled')
      pending.push(create('unc-canceled', firstPath))
      await vi.advanceTimersByTimeAsync(1_100)
      expect(statMock).toHaveBeenCalledTimes(2)
      expect((await create('healthy', 'C:\\healthy')).isNew).toBe(true)
      expect(active).toBe(2)
    } finally {
      release()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.allSettled([canceled, ...pending])
    }
    expect(peak).toBe(2)
    expect(host.listSessions()).toHaveLength(4)
    expect(statMock).toHaveBeenCalledTimes(4)
  })

  it('omits the verdict on attach to an existing session', async () => {
    await create('attach', '/work/repo')
    const attached = await create('attach', '/work/repo')
    expect(attached.isNew).toBe(false)
    expect(attached.cwdReadableByDaemon).toBeUndefined()
  })

  it.each(['open', 'read', 'close'] as const)(
    'starts a shell when the diagnostic directory %s remains pending',
    async (stage) => {
      vi.useFakeTimers()
      const { release, directory } = stallEnumeration(stage)
      const creation = create(`slow-${stage}`, `/work/slow-${stage}`)
      try {
        await vi.advanceTimersByTimeAsync(1_000)
        expect(host.listSessions()).toHaveLength(1)
        await expect(creation).resolves.toMatchObject({ isNew: true })
        expect((await creation).cwdReadableByDaemon).toBeUndefined()
      } finally {
        release()
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(directory.close).toHaveBeenCalledOnce()
    }
  )

  it('reuses a pending directory probe across timeouts and probes again after it settles', async () => {
    vi.useFakeTimers()
    const { release } = stallEnumeration('open')
    try {
      const first = create('first-prompt', '/work/prompt')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(host.listSessions()).toHaveLength(1)
      await first
      const second = create('second-prompt', '/work/prompt')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(host.listSessions()).toHaveLength(2)
      await second
      expect(opendirMock).toHaveBeenCalledOnce()
    } finally {
      release()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect((await create('after-prompt', '/work/prompt')).cwdReadableByDaemon).toBe(true)
    expect(opendirMock).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending probe without spawning and releases the session id for a retry', async () => {
    vi.useFakeTimers()
    const { release, directory } = stallEnumeration('open')
    const abort = new AbortController()
    const creation = create('canceled-prompt', '/work/canceled-prompt', abort.signal)
    let error: unknown
    void creation.catch((rejection: unknown) => {
      error = rejection
    })
    try {
      abort.abort()
      await vi.advanceTimersByTimeAsync(0)
      expect(spawnSubprocess).not.toHaveBeenCalled()
      expect(host.listSessions()).toEqual([])
      expect(error).toMatchObject({ message: 'Attach canceled for session canceled-prompt' })
      const retry = create('canceled-prompt', '/work/canceled-prompt')
      await vi.advanceTimersByTimeAsync(1_000)
      expect(host.listSessions()).toHaveLength(1)
      await expect(retry).resolves.toMatchObject({ isNew: true })
      expect(opendirMock).toHaveBeenCalledOnce()
    } finally {
      release()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(directory.close).toHaveBeenCalledOnce()
  })

  it('does not launch a shell when shutdown starts during a pending probe', async () => {
    vi.useFakeTimers()
    const { release } = stallEnumeration('open')
    const creation = create('shutdown-prompt', '/work/shutdown-prompt')
    let error: unknown
    void creation.catch((rejection: unknown) => {
      error = rejection
    })
    const disposal = host.dispose()
    try {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(spawnSubprocess).not.toHaveBeenCalled()
      expect(error).toMatchObject({ message: 'Terminal host is shutting down' })
      await disposal
      expect(host.listSessions()).toEqual([])
    } finally {
      release()
      await vi.advanceTimersByTimeAsync(0)
    }
  })
})
