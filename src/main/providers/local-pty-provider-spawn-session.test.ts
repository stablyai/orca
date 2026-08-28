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
  readWindowsPtyJobProcessIdsMock,
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
  readWindowsPtyJobProcessIdsMock: vi.fn(),
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

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
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

import { LocalPtyProvider } from './local-pty-provider'
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
      readWindowsPtyJobProcessIdsMock,
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

  describe('spawn', () => {
    it('returns a unique PTY id', async () => {
      const result = await provider.spawn({ cols: 80, rows: 24 })
      expect(result.id).toBeTruthy()
      expect(typeof result.id).toBe('string')
    })

    it('reattaches to an existing caller-supplied session id without spawning', async () => {
      const first = await provider.spawn({ cols: 80, rows: 24, sessionId: 'serve-session-1' })
      spawnMock.mockClear()

      const second = await provider.spawn({ cols: 120, rows: 40, sessionId: first.id })

      expect(second).toEqual({
        id: 'serve-session-1',
        pid: 12345,
        isReattach: true
      })
      expect(mockProc.resize).toHaveBeenCalledWith(120, 40)
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('attaches only to an existing stable session', async () => {
      await provider.spawn({ cols: 80, rows: 24, sessionId: 'stable-pane-session' })
      spawnMock.mockClear()

      const result = await provider.spawn({
        cols: 120,
        rows: 40,
        sessionId: 'stable-pane-session',
        attachOnly: true
      })

      expect(result).toMatchObject({ id: 'stable-pane-session', isReattach: true })
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('does not create when an attach-only stable session is absent', async () => {
      await expect(
        provider.spawn({
          cols: 80,
          rows: 24,
          sessionId: 'missing-stable-pane-session',
          attachOnly: true
        })
      ).rejects.toThrow('Session not found: missing-stable-pane-session')
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('attaches only to an existing numeric provider session', async () => {
      const first = await provider.spawn({ cols: 80, rows: 24 })
      spawnMock.mockClear()

      const result = await provider.spawn({
        cols: 120,
        rows: 40,
        sessionId: first.id,
        attachOnly: true
      })

      expect(result).toMatchObject({ id: first.id, isReattach: true })
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('does not create when a numeric attach-only provider session is absent', async () => {
      await expect(
        provider.spawn({ cols: 80, rows: 24, sessionId: '404', attachOnly: true })
      ).rejects.toThrow('Session not found: 404')
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('keeps a native UNC session native on a conflicting WSL reattach', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const first = await provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'native-session',
        cwd: '\\\\server\\share\\repo',
        shellOverride: 'powershell.exe'
      })
      spawnMock.mockClear()

      const second = await provider.spawn({
        cols: 120,
        rows: 40,
        sessionId: first.id,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu'
      })

      expect(first.wslDistro).toBeNull()
      expect(second.wslDistro).toBeNull()
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('keeps the first WSL distro on a conflicting distro reattach', async () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const first = await provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'wsl-session',
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
      })
      spawnMock.mockClear()

      const second = await provider.spawn({
        cols: 120,
        rows: 40,
        sessionId: first.id,
        shellOverride: 'wsl.exe',
        terminalWindowsWslDistro: 'Debian'
      })

      expect(first.wslDistro).toBe('Ubuntu')
      expect(second.wslDistro).toBe('Ubuntu')
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('does not reattach numeric caller session ids that can collide after restart', async () => {
      const first = await provider.spawn({ cols: 80, rows: 24 })
      spawnMock.mockClear()

      const second = await provider.spawn({ cols: 120, rows: 40, sessionId: first.id })

      expect(second.id).not.toBe(first.id)
      expect(second.isReattach).toBeUndefined()
      expect(spawnMock).toHaveBeenCalledOnce()
    })

    it('does not spawn after shutdown cancels a pending stable session id', async () => {
      let finishPreparation!: () => void
      spawnMock.mockClear()
      prepareMacosTccLoginShellMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPreparation = resolve
          })
      )

      const spawn = provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'pending-local-session'
      })
      const canceledSpawn = expect(spawn).rejects.toThrow(
        'PTY spawn canceled: pending-local-session'
      )
      await vi.waitFor(() => expect(prepareMacosTccLoginShellMock).toHaveBeenCalledOnce())

      await provider.shutdown('pending-local-session', { immediate: true })
      finishPreparation()
      await canceledSpawn
      expect(spawnMock).not.toHaveBeenCalled()

      await expect(
        provider.spawn({ cols: 80, rows: 24, sessionId: 'pending-local-session' })
      ).resolves.toMatchObject({ id: 'pending-local-session' })
      expect(spawnMock).toHaveBeenCalledOnce()
    })

    // Why (#16441): the Codex hook install and trust grant moved into
    // buildSpawnEnv, so the env build is now the long await before node-pty
    // exists — shutdown must be able to cancel the session id during it.
    it('does not spawn after shutdown cancels a pending spawn during the env build', async () => {
      spawnMock.mockClear()
      let finishEnvBuild!: (env: Record<string, string>) => void
      const buildSpawnEnv = vi.fn(
        (_id: string, baseEnv: Record<string, string>) =>
          new Promise<Record<string, string>>((resolve) => {
            finishEnvBuild = () => resolve(baseEnv)
          })
      )
      const envProvider = new LocalPtyProvider({ buildSpawnEnv })

      const spawn = envProvider.spawn({ cols: 80, rows: 24, sessionId: 'env-build-session' })
      const canceledSpawn = expect(spawn).rejects.toThrow('PTY spawn canceled: env-build-session')
      await vi.waitFor(() => expect(buildSpawnEnv).toHaveBeenCalledOnce())

      await envProvider.shutdown('env-build-session', { immediate: true })
      finishEnvBuild({})
      await canceledSpawn
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('coalesces a concurrent same-session-id spawn before launching a redundant shell (F3)', async () => {
      spawnMock.mockClear()
      const procA = { ...mockProc, pid: 1001 }
      spawnMock.mockReturnValueOnce(procA)

      // Hold both spawns past the existence check and inside the preflight so they
      // race to register the same id; release only after both are parked.
      let releasePreflight!: () => void
      prepareMacosTccLoginShellMock.mockReturnValue(
        new Promise<void>((resolve) => {
          releasePreflight = resolve
        })
      )

      const spawnA = provider.spawn({ cols: 80, rows: 24, sessionId: 'race-session' })
      const spawnB = provider.spawn({ cols: 132, rows: 44, sessionId: 'race-session' })
      await vi.waitFor(() => expect(prepareMacosTccLoginShellMock).toHaveBeenCalledTimes(2))
      releasePreflight()

      const [a, b] = await Promise.all([spawnA, spawnB])
      // The winner owns the tracked PTY; the loser attaches to it, not a second one.
      expect(a.isReattach).toBeUndefined()
      expect(b.isReattach).toBe(true)
      expect(b.pid).toBe(procA.pid)
      expect(provider.getPtyProcess('race-session')).toBe(procA)
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(procA.resize).toHaveBeenCalledWith(132, 44)
    })

    it('invokes onSpawned callback', async () => {
      const onSpawned = vi.fn()
      provider.configure({ onSpawned })
      const { id, incarnationId } = await provider.spawn({ cols: 80, rows: 24 })
      expect(onSpawned).toHaveBeenCalledWith(id, incarnationId)
    })

    it('reports physical commit before post-spawn publication can fail', async () => {
      spawnMock.mockClear()
      const committed = vi.fn()
      provider.configure({
        onSpawned: () => {
          throw new Error('post-spawn publication failed')
        }
      })

      await expect(
        provider.spawn({ cols: 80, rows: 24, onPtySpawnCommitted: committed })
      ).rejects.toThrow('post-spawn publication failed')
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(committed).toHaveBeenCalledOnce()
    })
  })
})
