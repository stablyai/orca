import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsConptyProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsConptyProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// Resolve PowerShell family names to deterministic absolute paths (the fs mock
// above otherwise makes every probe miss). The real resolver — which skips the
// Store App Execution Alias stub — is covered in
// windows-powershell-executable.test.ts.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-conpty-process-membership', () => ({
  readWindowsConptyProcessIds: (...args: unknown[]) => readWindowsConptyProcessIdsMock(...args)
}))

vi.mock('../wsl', () => ({
  parseWslPath: (path: string) => {
    const match = path.match(/^\\\\wsl\.localhost\\([^\\]+)(.*)$/)
    if (!match) {
      return null
    }
    return {
      distro: match[1],
      linuxPath: (match[2] || '').replace(/\\/g, '/') || '/'
    }
  },
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  // Why: WSL worktree validation now asks the distro; these tests use WSL UNC
  // cwds that are meant to exist, so report them present without spawning wsl.exe.
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import {
  LOCAL_PTY_FORCE_KILL_RETRY_MS,
  LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS,
  LOCAL_PTY_PHYSICAL_EXIT_TIMEOUT_MS,
  LocalPtyProvider
} from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: ((info: { exitCode: number }) => void) | undefined

  installLocalPtyProviderEnvSandbox()

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsConptyProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })

    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    spawnMock.mockReturnValue(mockProc)

    provider = new LocalPtyProvider()
  })

  describe('shutdown', () => {
    it('kills the PTY process', async () => {
      // Why: capture the spy reference before shutdown triggers onExit →
      // POSIX kill neutralization. After neutralization, mockProc.kill is
      // replaced with a non-spy no-op to close the UnixTerminal.destroy() →
      // socket-close → SIGHUP-to-recycled-pid race (see docs/fix-pty-fd-leak.md).
      const killSpy = mockProc.kill
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      await provider.shutdown(id, { immediate: true })
      expect(killSpy).toHaveBeenCalled()
    })

    it('invokes onExit callback via the node-pty exit handler', async () => {
      const onExit = vi.fn()
      provider.configure({ onExit })
      const { id, incarnationId } = await provider.spawn({ cols: 80, rows: 24 })
      await provider.shutdown(id, { immediate: true })
      expect(onExit).toHaveBeenCalledWith(id, -1, incarnationId, {
        kind: 'unknown',
        reason: 'stop_unverified'
      })
    })

    it('does not destroy after an intentional Windows shutdown kill', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const killSpy = vi.fn()
      const destroySpy = vi.fn(() => {
        killSpy()
      })
      spawnMock.mockReturnValue({
        ...mockProc,
        kill: killSpy,
        destroy: destroySpy
      })

      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      const shutdown = provider.shutdown(id, { immediate: true })
      exitCb?.({ exitCode: -1 })
      await shutdown

      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(destroySpy).not.toHaveBeenCalled()
    })

    it('keeps shutdown and ownership pending until node-pty reports physical exit', async () => {
      const killSpy = vi.fn()
      mockProc.kill = killSpy
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      let settled = false
      const shutdown = provider.shutdown(id, { immediate: true }).finally(() => {
        settled = true
      })
      await Promise.resolve()

      expect(killSpy).toHaveBeenCalledWith('SIGKILL')
      expect(settled).toBe(false)
      expect(provider.hasPty(id)).toBe(true)
      exitCb?.({ exitCode: 137 })
      await shutdown
      expect(provider.hasPty(id)).toBe(false)
    })

    it('keeps physical-exit tracking when orphan cleanup races immediate shutdown', async () => {
      const killSpy = vi.fn(() => {
        queueMicrotask(() => exitCb?.({ exitCode: 137 }))
      })
      mockProc.kill = killSpy
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      const shutdown = provider.shutdown(id, { immediate: true })
      expect(provider.killOrphanedPtys(1)).toEqual([{ id }])
      expect(provider.hasPty(id)).toBe(true)

      await expect(shutdown).resolves.toBeUndefined()
      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(provider.hasPty(id)).toBe(false)
    })

    it('escalates graceful shutdown before orphan cleanup disables the kill handle', async () => {
      vi.useFakeTimers()
      try {
        const killSpy = vi.fn()
        mockProc.kill = killSpy
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        const graceful = provider.shutdown(id, { immediate: false })
        expect(killSpy.mock.calls).toEqual([['SIGTERM']])

        expect(provider.killOrphanedPtys(1)).toEqual([{ id }])
        expect(killSpy.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])

        // The original graceful deadline was replaced by the immediate
        // escalation, so it cannot call the now-neutralized proc.kill later.
        await vi.advanceTimersByTimeAsync(LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS)
        expect(killSpy).toHaveBeenCalledTimes(2)
        exitCb?.({ exitCode: 137 })
        await graceful
        expect(provider.hasPty(id)).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('escalates a graceful shutdown when destructive cleanup joins it', async () => {
      const killSpy = vi.fn()
      mockProc.kill = killSpy
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      const graceful = provider.shutdown(id, { immediate: false })
      const immediate = provider.shutdown(id, { immediate: true })
      expect(killSpy.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])

      exitCb?.({ exitCode: 137 })
      await Promise.all([graceful, immediate])
      expect(provider.hasPty(id)).toBe(false)
    })

    it('force-kills a POSIX PTY that ignores graceful shutdown', async () => {
      vi.useFakeTimers()
      try {
        const killSpy = vi.fn()
        mockProc.kill = killSpy
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        const graceful = provider.shutdown(id, { immediate: false })
        expect(killSpy.mock.calls).toEqual([['SIGTERM']])

        await vi.advanceTimersByTimeAsync(LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS)
        expect(killSpy.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
        exitCb?.({ exitCode: 137 })
        await graceful
        expect(provider.hasPty(id)).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('retries a rejected graceful-deadline SIGKILL before the physical timeout', async () => {
      vi.useFakeTimers()
      try {
        let forceAttempts = 0
        const killSpy = vi.fn((signal: string) => {
          if (signal === 'SIGKILL' && forceAttempts++ === 0) {
            throw new Error('transient force-kill failure')
          }
        })
        mockProc.kill = killSpy
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        const graceful = provider.shutdown(id, { immediate: false })
        await vi.advanceTimersByTimeAsync(LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS)
        expect(killSpy.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
        expect(provider.hasPty(id)).toBe(true)

        await vi.advanceTimersByTimeAsync(LOCAL_PTY_FORCE_KILL_RETRY_MS)
        expect(killSpy.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']])
        exitCb?.({ exitCode: 137 })
        await graceful
        expect(provider.hasPty(id)).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not double-kill ConPTY when destructive cleanup joins shutdown', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const killSpy = vi.fn()
      mockProc.kill = killSpy
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      const graceful = provider.shutdown(id, { immediate: false })
      const immediate = provider.shutdown(id, { immediate: true })
      expect(killSpy.mock.calls).toEqual([[]])

      exitCb?.({ exitCode: 137 })
      await Promise.all([graceful, immediate])
      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(provider.hasPty(id)).toBe(false)
    })

    it('rejects a physical-exit timeout but retains the owner for a successful retry', async () => {
      vi.useFakeTimers()
      try {
        const killSpy = vi.fn()
        mockProc.kill = killSpy
        const { id } = await provider.spawn({ cols: 80, rows: 24 })

        const shutdown = provider.shutdown(id, { immediate: true })
        const rejected = expect(shutdown).rejects.toThrow('Timed out waiting for PTY process exit')
        await vi.advanceTimersByTimeAsync(LOCAL_PTY_PHYSICAL_EXIT_TIMEOUT_MS)
        await rejected
        expect(provider.hasPty(id)).toBe(true)

        const retry = provider.shutdown(id, { immediate: true })
        expect(killSpy).toHaveBeenCalledTimes(1)
        exitCb?.({ exitCode: 137 })
        await expect(retry).resolves.toBeUndefined()
        expect(provider.hasPty(id)).toBe(false)
      } finally {
        vi.useRealTimers()
      }
    })

    it('propagates kill failure without dropping the physical owner', async () => {
      mockProc.kill = vi.fn(() => {
        throw new Error('kill denied')
      })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await expect(provider.shutdown(id, { immediate: true })).rejects.toThrow('kill denied')
      expect(provider.hasPty(id)).toBe(true)

      mockProc.kill = vi.fn(() => exitCb?.({ exitCode: 137 }))
      await expect(provider.shutdown(id, { immediate: true })).resolves.toBeUndefined()
      expect(provider.hasPty(id)).toBe(false)
    })

    it('cancels pending shell-ready startup delivery on forced shutdown', async () => {
      vi.useFakeTimers()
      try {
        const { id } = await provider.spawn({ cols: 80, rows: 24, command: 'printf ready' })

        await provider.shutdown(id, { immediate: true })
        vi.advanceTimersByTime(2000)
        await Promise.resolve()

        expect(mockProc.write).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('is a no-op for unknown PTY ids', async () => {
      await provider.shutdown('nonexistent', { immediate: true })
      expect(mockProc.kill).not.toHaveBeenCalled()
    })

    it('waits for an in-flight agent shutdown before reusing the same session id', async () => {
      let releaseSweep!: () => void
      killWithDescendantSweepMock.mockImplementation(
        (_rootPid: number, killRoot: () => void) =>
          new Promise<void>((resolve) => {
            releaseSweep = () => {
              killRoot()
              resolve()
            }
          })
      )
      const spawnArgs = {
        cols: 80,
        rows: 24,
        sessionId: 'stable-agent-session',
        launchAgent: 'claude' as const
      }
      const spawnCallsBefore = spawnMock.mock.calls.length
      const { id } = await provider.spawn(spawnArgs)

      const shutdown = provider.shutdown(id, { immediate: true })
      const respawn = provider.spawn(spawnArgs)
      await Promise.resolve()
      expect(spawnMock).toHaveBeenCalledTimes(spawnCallsBefore + 1)

      releaseSweep()
      await shutdown
      await respawn
      expect(spawnMock).toHaveBeenCalledTimes(spawnCallsBefore + 2)
    })

    it('coalesces duplicate shutdown while descendant sweep is pending', async () => {
      let releaseSweep!: () => void
      killWithDescendantSweepMock.mockImplementation(
        (_rootPid: number, killRoot: () => void) =>
          new Promise<void>((resolve) => {
            releaseSweep = () => {
              killRoot()
              resolve()
            }
          })
      )
      const { id } = await provider.spawn({
        cols: 80,
        rows: 24,
        launchAgent: 'claude'
      })

      const first = provider.shutdown(id, { immediate: true })
      const second = provider.shutdown(id, { immediate: true })
      expect(killWithDescendantSweepMock).toHaveBeenCalledOnce()
      releaseSweep()
      await Promise.all([first, second])
      expect(killWithDescendantSweepMock).toHaveBeenCalledOnce()
    })

    it('does not terminate descendants after the tracked root exits mid-sweep', async () => {
      const terminateDescendants = vi.fn()
      let releaseSweep!: () => void
      killWithDescendantSweepMock.mockImplementation(
        (_rootPid: number, killRoot: () => void, deps?: { ownsRoot?: () => boolean }) =>
          new Promise<void>((resolve) => {
            releaseSweep = () => {
              // Production killWithDescendantSweep only signals descendants while ownsRoot.
              if (deps?.ownsRoot?.() ?? true) {
                terminateDescendants()
              }
              killRoot()
              resolve()
            }
          })
      )
      const { id } = await provider.spawn({
        cols: 80,
        rows: 24,
        launchAgent: 'claude'
      })

      const shutdown = provider.shutdown(id, { immediate: true })
      exitCb?.({ exitCode: 0 })
      releaseSweep()
      await shutdown

      expect(terminateDescendants).not.toHaveBeenCalled()
    })

    it('win32 immediate shutdown of a plain shell taskkills the descendant tree', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await provider.shutdown(id, { immediate: true })

      // Why: an orphaned pnpm/node child otherwise keeps the ConPTY console alive and holds
      // the worktree cwd; the sweep taskkill /T /F clears the tree so removal can proceed.
      expect(killWithDescendantSweepMock).toHaveBeenCalledWith(
        mockProc.pid,
        expect.any(Function),
        expect.objectContaining({ ownsRoot: expect.any(Function) })
      )
    })

    it('win32 graceful shutdown of a plain shell does not taskkill the tree', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await provider.shutdown(id, { immediate: false })

      expect(killWithDescendantSweepMock).not.toHaveBeenCalled()
    })

    it('non-win32 immediate shutdown of a plain shell skips the tree kill', async () => {
      // beforeEach pins platform to linux; POSIX force-kill already reaches the child pgroup.
      const { id } = await provider.spawn({ cols: 80, rows: 24 })

      await provider.shutdown(id, { immediate: true })

      expect(killWithDescendantSweepMock).not.toHaveBeenCalled()
    })
  })

  describe('killAll', () => {
    it('kills all PTY processes', async () => {
      // Why: each spawn needs its own proc so the onExit-triggered POSIX kill
      // neutralization on one proc does not replace the kill function on the
      // other (mockProc is shared by default in beforeEach). Each proc also
      // needs its own exitCb holder — the default mockProc.onExit assigns to
      // the shared `exitCb` variable, so the second spawn would overwrite the
      // first's exit callback, and mock1Kill firing would trigger cleanup for
      // id2 (removing it from the map before killAll iterates to it).
      let exit1: ((e: { exitCode: number }) => void) | undefined
      let exit2: ((e: { exitCode: number }) => void) | undefined
      const mock1Kill = vi.fn(() => exit1?.({ exitCode: -1 }))
      const mock2Kill = vi.fn(() => exit2?.({ exitCode: -1 }))
      spawnMock
        .mockReturnValueOnce({
          ...mockProc,
          kill: mock1Kill,
          onExit: vi.fn((cb) => {
            exit1 = cb
          })
        })
        .mockReturnValueOnce({
          ...mockProc,
          kill: mock2Kill,
          onExit: vi.fn((cb) => {
            exit2 = cb
          })
        })

      await provider.spawn({ cols: 80, rows: 24 })
      await provider.spawn({ cols: 80, rows: 24 })

      provider.killAll()

      expect(mock1Kill).toHaveBeenCalled()
      expect(mock2Kill).toHaveBeenCalled()
      const list = await provider.listProcesses()
      expect(list).toHaveLength(0)
    })

    it('does not destroy after intentional Windows orphan kills', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const destroySpy = vi.fn()
      const killSpy = vi.fn()
      spawnMock.mockReturnValue({
        ...mockProc,
        kill: killSpy,
        destroy: destroySpy
      })

      await provider.spawn({ cols: 80, rows: 24 })

      provider.killAll()

      expect(killSpy).toHaveBeenCalledTimes(1)
      expect(destroySpy).not.toHaveBeenCalled()
    })

    it('settles an overlapping shutdown when app quit takes final ownership', async () => {
      mockProc.kill.mockImplementation(() => undefined)
      const { id } = await provider.spawn({ cols: 80, rows: 24 })
      const shutdown = provider.shutdown(id, { immediate: true })
      let settled = false
      void shutdown.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)

      provider.killAll()

      await expect(shutdown).resolves.toBeUndefined()
    })
  })
})
