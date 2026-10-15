import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { killWithDescendantSweep } from '../pty-descendant-termination'
import type { runWslGuestTreeKill } from './wsl-guest-tree-kill'
import type { SubprocessHandle } from './session-subprocess-handle'
import { terminateShutdownDescendants } from './terminal-descendant-shutdown'
import { TerminalHost } from './terminal-host'

const killWithDescendantSweepMock = vi.hoisted(() => vi.fn<typeof killWithDescendantSweep>())
vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

const runWslGuestTreeKillMock = vi.hoisted(() => vi.fn<typeof runWslGuestTreeKill>())
vi.mock('./wsl-guest-tree-kill', () => ({
  runWslGuestTreeKill: runWslGuestTreeKillMock
}))

function createMockSubprocess(): SubprocessHandle & { exit: (code: number) => void } {
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 99999,
    exit: (code: number) => onExit?.(code),
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable',
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((callback) => {
      onExit = callback
    }),
    dispose: vi.fn()
  }
}

async function createHost(
  subprocess: SubprocessHandle,
  options: { agent?: boolean; wsl?: boolean } = { agent: true }
): Promise<TerminalHost> {
  const host = new TerminalHost({ spawnSubprocess: () => subprocess })
  await host.createOrAttach({
    sessionId: 'session-1',
    cols: 80,
    rows: 24,
    launchAgent: options.agent ? 'claude' : undefined,
    ...(options.wsl ? { shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Ubuntu' } : {}),
    streamClient: { onData: vi.fn(), onExit: vi.fn() }
  })
  return host
}

function sweepDeps() {
  const lastCall = killWithDescendantSweepMock.mock.calls.at(-1)
  if (!lastCall?.[2]) {
    throw new Error('expected sweep dependencies')
  }
  return lastCall[2]
}

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

describe('TerminalHost dispose descendant sweep', () => {
  let platformDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    setPlatform('linux')
    killWithDescendantSweepMock.mockReset()
    killWithDescendantSweepMock.mockImplementation(async (_pid, killRoot) => killRoot())
    runWslGuestTreeKillMock.mockReset()
    runWslGuestTreeKillMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it.each([true, false])('verifies descendants on dispose with agent=%s', async (agent) => {
    const subprocess = createMockSubprocess()
    const host = await createHost(subprocess, { agent })

    await host.dispose()

    expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
      subprocess.pid,
      expect.any(Function),
      expect.objectContaining({
        ownsRoot: expect.any(Function),
        terminateDescendants: terminateShutdownDescendants,
        awaitEscalation: true
      })
    )
    expect(subprocess.forceKill).toHaveBeenCalledOnce()
    expect(subprocess.dispose).toHaveBeenCalledOnce()
  })

  it('retains the root through descendant cleanup and its native handle until physical exit', async () => {
    const subprocess = createMockSubprocess()
    subprocess.forceKill = vi.fn()
    const host = await createHost(subprocess)
    const sweep = Promise.withResolvers<void>()
    killWithDescendantSweepMock.mockImplementationOnce((_pid, killRoot) => {
      killRoot()
      return sweep.promise
    })
    let disposed = false
    const pending = host.dispose().then(() => {
      disposed = true
    })

    await Promise.resolve()
    expect(subprocess.forceKill).not.toHaveBeenCalled()
    expect(subprocess.dispose).not.toHaveBeenCalled()
    expect(disposed).toBe(false)

    sweep.resolve()
    await vi.waitFor(() => expect(subprocess.forceKill).toHaveBeenCalledOnce())
    expect(subprocess.dispose).not.toHaveBeenCalled()
    expect(disposed).toBe(false)

    subprocess.exit(137)
    await pending
    expect(disposed).toBe(true)
    expect(subprocess.forceKill).toHaveBeenCalledOnce()
    expect(subprocess.dispose).toHaveBeenCalledOnce()
  })

  it.each(['win32', 'linux', 'darwin'] as const)(
    '%s shutdown anchors the sweep to the spawn identity with a Windows-only deadline',
    async (platform) => {
      setPlatform(platform)
      const subprocess = createMockSubprocess()
      subprocess.spawnIdentity = { rootCreationTimeMs: 777 }
      const host = await createHost(subprocess)

      await host.dispose()

      expect(sweepDeps().expectedRootCreationTimeMs).toBe(777)
      expect(sweepDeps().sweepTimeoutMs).toBe(platform === 'win32' ? 4_000 : undefined)
    }
  )

  it.each([true, false])(
    'cleans the WSL guest tree concurrently with the Windows sweep with agent=%s',
    async (agent) => {
      setPlatform('win32')
      const subprocess = createMockSubprocess()
      subprocess.spawnIdentity = { ptyTreeId: 'sess@@abc123' }
      const host = await createHost(subprocess, { agent, wsl: true })
      const sweep = Promise.withResolvers<void>()
      const guest = Promise.withResolvers<void>()
      killWithDescendantSweepMock.mockReturnValueOnce(sweep.promise)
      runWslGuestTreeKillMock.mockReturnValueOnce(guest.promise)
      let disposed = false
      const pending = host.dispose().then(() => {
        disposed = true
      })

      expect(killWithDescendantSweepMock).toHaveBeenCalledOnce()
      expect(runWslGuestTreeKillMock).toHaveBeenCalledWith({
        distro: 'Ubuntu',
        treeId: 'sess@@abc123'
      })
      sweep.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(subprocess.forceKill).not.toHaveBeenCalled()
      expect(disposed).toBe(false)

      guest.resolve()
      await pending
      expect(subprocess.forceKill).toHaveBeenCalledOnce()
      expect(subprocess.dispose).toHaveBeenCalledOnce()
    }
  )

  it.each([true, false])(
    'joins WSL cleanup once during a tracked close without duplicating the host sweep, agent=%s',
    async (agent) => {
      setPlatform('win32')
      const subprocess = createMockSubprocess()
      subprocess.spawnIdentity = { ptyTreeId: 'sess@@abc123' }
      const host = await createHost(subprocess, { agent, wsl: true })
      const sweep = Promise.withResolvers<void>()
      const guest = Promise.withResolvers<void>()
      killWithDescendantSweepMock.mockImplementationOnce(async (_pid, killRoot) => {
        await sweep.promise
        killRoot()
      })
      runWslGuestTreeKillMock.mockReturnValueOnce(guest.promise)
      const killed = host.kill('session-1', { immediate: true })
      let disposed = false
      const shutdown = host.dispose()
      void shutdown.then(() => {
        disposed = true
      })

      expect(host.dispose()).toBe(shutdown)
      expect(killWithDescendantSweepMock).toHaveBeenCalledOnce()
      expect(runWslGuestTreeKillMock).toHaveBeenCalledExactlyOnceWith({
        distro: 'Ubuntu',
        treeId: 'sess@@abc123'
      })
      expect(subprocess.forceKill).not.toHaveBeenCalled()

      sweep.resolve()
      await killed
      expect(subprocess.forceKill).toHaveBeenCalledOnce()
      expect(disposed).toBe(false)

      guest.resolve()
      await shutdown
      expect(killWithDescendantSweepMock).toHaveBeenCalledOnce()
      expect(runWslGuestTreeKillMock).toHaveBeenCalledOnce()
      expect(subprocess.dispose).toHaveBeenCalledOnce()
    }
  )

  it.each([
    { platform: 'win32' as const, wsl: false, marker: 'sess@@abc123' },
    { platform: 'win32' as const, wsl: true, marker: undefined },
    { platform: 'linux' as const, wsl: false, marker: 'sess@@abc123' }
  ])('skips the guest kill when no WSL guest identity is available: %j', async (testCase) => {
    setPlatform(testCase.platform)
    const subprocess = createMockSubprocess()
    subprocess.spawnIdentity = { ptyTreeId: testCase.marker }
    const host = await createHost(subprocess, { agent: true, wsl: testCase.wsl })

    await host.dispose()

    expect(runWslGuestTreeKillMock).not.toHaveBeenCalled()
    expect(subprocess.forceKill).toHaveBeenCalledOnce()
  })
})
