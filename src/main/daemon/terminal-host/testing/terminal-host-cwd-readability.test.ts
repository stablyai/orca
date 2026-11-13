import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessHandle } from '../../sessions/session-subprocess-handle'
import { TerminalHost } from '../terminal-host'

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

vi.mock('../../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: vi.fn()
}))

const close = vi.fn(async () => {})
const spawnSubprocess = vi.fn(() => createMockSubprocess())

function dirReading(read: () => unknown): { read: () => unknown; close: () => Promise<void> } {
  return { read, close }
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
