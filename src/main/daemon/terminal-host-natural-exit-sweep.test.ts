/**
 * A PTY that ends on its own used to end Orca's interest in what it spawned.
 *
 * `handleSessionExit` disposed the handle and reaped the session; no descendant
 * sweep ran on that path at all, so a tool shell that had already reparented to
 * pid 1 — or that sat outside the terminal's foreground group, where the
 * kernel's hang-up never reaches — survived its session indefinitely (#22346).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { PtySessionProcessIdentity } from '../pty-session-identity'
import type * as DescendantTermination from '../pty-descendant-termination'

const sweepMock = vi.hoisted(() => vi.fn(async () => 'exited' as const))
vi.mock('./terminal-session-descendant-sweep', () => ({
  sweepTerminalSessionDescendants: sweepMock
}))
vi.mock('../pty-descendant-termination', async (importOriginal) => ({
  ...(await importOriginal<typeof DescendantTermination>()),
  killWithDescendantSweep: vi.fn(),
  // The session records a real slave path, so its post-spawn capture must not fork a `ps`.
  readProcessTable: vi.fn(async () => ({ rows: [], capturedAtMs: Date.now() }))
}))

function createMockSubprocess(): SubprocessHandle & { exit: (code: number) => void } {
  let onExitCb: ((code: number) => void) | null = null
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements the subprocess contract and adds a test-only exit trigger.
  return {
    pid: 99999,
    slavePath: '/dev/ttys042',
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit(cb) {
      onExitCb = cb
    },
    dispose: vi.fn(),
    exit: (code: number) => onExitCb?.(code)
  } as SubprocessHandle & { exit: (code: number) => void }
}

describe('TerminalHost natural-exit descendant sweep', () => {
  let host: TerminalHost
  let subprocess: ReturnType<typeof createMockSubprocess>
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    sweepMock.mockClear()
    const spawnSubprocess: TerminalHostOptions['spawnSubprocess'] = () => {
      subprocess = createMockSubprocess()
      return subprocess
    }
    host = new TerminalHost({ spawnSubprocess })
  })

  afterEach(async () => {
    await host.dispose()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  async function createSession(sessionId: string): Promise<void> {
    await host.createOrAttach({
      sessionId,
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  it('sweeps from the exiting session identity, not from its reaped root pid', async () => {
    await createSession('natural-exit')

    subprocess.exit(0)

    expect(sweepMock).toHaveBeenCalledTimes(1)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock records the identity this sweep was given.
    const swept = (sweepMock.mock.calls as unknown as [PtySessionProcessIdentity][])[0][0]
    expect(swept.rootPid).toBe(99999)
    // The terminal recorded at spawn outlives the handle that named it.
    expect(swept.ttyName).toBe('ttys042')
    // Set before the sweep, so a tty match cannot be confused with a new session's.
    expect(swept.rootExitedAtMs).not.toBeNull()
  })

  it('leaves a session already being torn down to the teardown that owns it', async () => {
    await createSession('killed')
    void host.kill('killed', { immediate: true })
    subprocess.exit(0)

    expect(sweepMock).not.toHaveBeenCalled()
  })

  it('waits out an exit sweep before reporting the host disposed', async () => {
    await createSession('slow-sweep')
    let release: () => void = () => {}
    sweepMock.mockReturnValueOnce(
      new Promise<'exited'>((resolve) => {
        release = () => resolve('exited')
      })
    )
    subprocess.exit(0)

    let disposed = false
    const disposal = host.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)

    release()
    await disposal
    expect(disposed).toBe(true)
  })
})
