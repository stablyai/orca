import type * as WslPathOwner from '../../../shared/wsl-paths'
import type * as WslAvailabilityTypes from '../../wsl/discovery/wsl-availability'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from '../macos-tcc-login-shell'
import type { ShellSpawnParams } from './local-pty-executable-spawn'

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
  wslUncDirectoryExistsAsyncMock,
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
  wslUncDirectoryExistsAsyncMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('../../../shared/wsl-paths', async (importOriginal) => ({
  ...(await importOriginal<typeof WslPathOwner>()),
  toLinuxPath: (path: string) => path.replace(/^C:\\/i, '/mnt/c/').replace(/\\/g, '/'),
  toWindowsWslPath: (path: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
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

// Concurrent first imports can race Vitest mocks and load the real node-pty addon under a mocked platform.
vi.mock('./local-pty-runtime-spawn', async () => {
  const { spawnShellWithFallback } = await import('./local-pty-executable-spawn')
  return {
    loadLocalPtyRuntimeSpawn: async () => (params: Omit<ShellSpawnParams, 'ptySpawn'>) =>
      spawnShellWithFallback({ ...params, ptySpawn: spawnMock })
  }
})

vi.mock('../macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

// The fs mock misses executable probes; pin paths here and leave Store-alias coverage to the resolver tests.
const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const PWSH7_ABS = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const CMD_ABS = 'C:\\Windows\\System32\\cmd.exe'
vi.mock('../windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe' ? PWSH7_ABS : WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: (family: 'pwsh.exe' | 'powershell.exe') =>
    family === 'pwsh.exe'
      ? [PWSH7_ABS, WINDOWS_POWERSHELL_ABS, CMD_ABS]
      : [WINDOWS_POWERSHELL_ABS, CMD_ABS],
  getWindowsCmdPath: () => CMD_ABS
}))

vi.mock('../agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('../windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../../wsl/filesystem/unc-path-access', () => ({
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
  wslUncDirectoryExistsAsync: (...args: unknown[]) => wslUncDirectoryExistsAsyncMock(...args)
}))
vi.mock('../../wsl/discovery/distro-catalog', () => ({
  getDefaultWslDistro: () => 'Ubuntu'
}))

vi.mock('../../wsl/discovery/wsl-availability', async (importOriginal) => ({
  ...(await importOriginal<typeof WslAvailabilityTypes>()),
  isWslAvailableAsync: () => isWslAvailableAsyncMock()
}))

vi.mock('../../pty/shell-startup/shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  ptyDisposables,
  ptyExitDisposables,
  ptyPhysicalExits,
  startupIngressByPty
} from './local-pty-provider-state'
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
      wslUncDirectoryExistsAsyncMock,
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
    it('retires buffered output and synchronous Bun exit before replying to spawn', async () => {
      const disposeData = vi.fn()
      const disposeExit = vi.fn()
      const onExit = vi.fn()
      provider.configure({ onExit })
      mockProc.onData.mockImplementation((listener: (data: string) => void) => {
        listener('last output')
        return { dispose: disposeData }
      })
      mockProc.onExit.mockImplementation((listener: (event: { exitCode: number }) => void) => {
        listener({ exitCode: 17 })
        return { dispose: disposeExit }
      })
      const result = await provider.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'already-exited-bun-shell',
        command: 'must-not-run'
      })
      expect(result.exitedBeforeSpawnReply).toBe(true)
      expect(provider.getPtyProcess(result.id)).toBeUndefined()
      for (const map of [
        ptyDisposables,
        ptyExitDisposables,
        ptyPhysicalExits,
        startupIngressByPty
      ]) {
        expect(map.has(result.id)).toBe(false)
      }
      expect(disposeData).toHaveBeenCalledOnce()
      expect(disposeExit).toHaveBeenCalledOnce()
      expect(onExit).toHaveBeenCalledOnce()
      await Promise.resolve()
      expect(mockProc.write).not.toHaveBeenCalled()
    })

    // Hook/trust setup makes env build a long pre-spawn await; shutdown must cancel during it (#16441).
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

    it.each([1, 2])(
      'keeps cancellation registered across %i environment-resume microtasks',
      async (microtasks) => {
        spawnMock.mockClear()
        let finishEnvBuild!: () => void
        const envProvider = new LocalPtyProvider({
          buildSpawnEnv: (_id, baseEnv) =>
            new Promise<Record<string, string>>((resolve) => {
              finishEnvBuild = () => resolve(baseEnv)
            })
        })
        const spawn = envProvider.spawn({
          cols: 80,
          rows: 24,
          sessionId: 'resolved-env-build-session'
        })
        const canceledSpawn = expect(spawn).rejects.toThrow(
          'PTY spawn canceled: resolved-env-build-session'
        )
        await vi.waitFor(() => expect(finishEnvBuild).toBeTypeOf('function'))

        finishEnvBuild()
        const shutdown = new Promise<void>((resolve, reject) => {
          const shutdown = () => {
            envProvider
              .shutdown('resolved-env-build-session', { immediate: true })
              .then(resolve, reject)
          }
          queueMicrotask(() => (microtasks === 1 ? shutdown() : queueMicrotask(shutdown)))
        })

        await shutdown
        await canceledSpawn
        expect(spawnMock).not.toHaveBeenCalled()
      }
    )

    it('coalesces a concurrent same-session-id spawn before launching a redundant shell (F3)', async () => {
      spawnMock.mockClear()
      const procA = { ...mockProc, pid: 1001 }
      spawnMock.mockReturnValueOnce(procA)

      // Park both spawns past the existence check to race same-id registration.
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
      expect(a.isReattach).toBeUndefined()
      expect(b.isReattach).toBe(true)
      expect(b.pid).toBe(procA.pid)
      expect(provider.getPtyProcess('race-session')).toBe(procA)
      expect(spawnMock).toHaveBeenCalledOnce()
      expect(procA.resize).toHaveBeenCalledWith(132, 44)
    })
  })
})
