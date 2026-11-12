import type * as WslPathOwner from '../../../shared/wsl-paths'
import type * as WslAvailabilityTypes from '../../wsl/discovery/wsl-availability'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from '../macos-tcc-login-shell'
import type * as PosixPtyProcessTable from '../../pty/process-retirement/posix-pty-process-table'
import { killAllProcessesForWorktrees } from '../../runtime/workspaces/removal/worktree-batch-teardown'
import { captureWorktreeTerminalStops } from '../../runtime/terminal/stop/worktree-terminal-removal-snapshot'
import { OrcaRuntimeWithStopTerminalsForWorktree } from '../../runtime/terminal/stop/worktree-terminal-stop'
import type { WorktreeTeardownRuntime } from '../../runtime/workspaces/removal/worktree-teardown'
import type { RuntimePtyWorktreeRecord } from '../../runtime/terminal/records/runtime-terminal-state-records'
import type { WorktreePtyStopContext } from '../../runtime/terminal/stop/worktree-terminal-stop-options'

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
  createShellPromptReadinessProbeMock,
  readProcessTableMock
} = vi.hoisted(() => ({
  readProcessTableMock: vi.fn<(rootPid: number) => Promise<string>>(),
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

vi.mock('../../runtime/terminal/launch/terminal-split-source-authority', () => ({
  OrcaRuntimeWithResolveTerminalSplitSourceAuthority: class {}
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

// Fixture pids must never be looked up in the real host process table.
vi.mock('../../pty/process-retirement/posix-pty-process-table', async (importOriginal) => ({
  ...(await importOriginal<typeof PosixPtyProcessTable>()),
  readPosixPtyProcessTable: readProcessTableMock,
  readPosixPtyProcessTableSync: () => ''
}))

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
import {
  LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS,
  LOCAL_PTY_PHYSICAL_EXIT_TIMEOUT_MS
} from './local-pty-termination'
import { LocalPtyProvider } from './local-pty-provider'
import { ptyIncarnations } from './local-pty-provider-state'
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
    readProcessTableMock.mockReset()
    readProcessTableMock.mockResolvedValue('')

    provider = new LocalPtyProvider()
  })

  describe('shutdown', () => {
    it('retains a provider-captured identity through a recordless graph stop before local replacement', async () => {
      const created = await provider.spawn({
        sessionId: 'folder:identity@@pane',
        worktreeId: 'folder:identity',
        cols: 80,
        rows: 24
      })
      const target = { worktreeId: 'folder:identity', connectionId: null }
      const records = new Map<string, RuntimePtyWorktreeRecord>()
      const kill = vi.spyOn(mockProc, 'kill').mockImplementation(() => {
        exitCb?.({ exitCode: 137 })
      })
      const shutdown = provider.shutdown.bind(provider)
      vi.spyOn(provider, 'shutdown').mockImplementation(async (id, options) => {
        ptyIncarnations.set(id, 'replacement-incarnation')
        await shutdown(id, options)
      })
      const controllerStop = vi.fn(async (id: string, options?: WorktreePtyStopContext) => {
        await provider.shutdown(id, { immediate: true, ...options })
        return true
      })
      const graph = {
        captureReadyGraphEpoch: () => 1,
        assertStableReadyGraph: () => {},
        ptysById: records,
        ptyController: { stopAndWait: controllerStop }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements every runtime port used by the batch and real runtime stop method.
      const runtime = {
        captureWorktreeTerminalStops: () =>
          captureWorktreeTerminalStops([target], {
            acquire: async () => {
              throw new Error('lease unavailable')
            },
            captureFence: () => () => {},
            leaves: () => [{ worktreeId: target.worktreeId, ptyId: created.id }],
            ptys: records
          }),
        stopTerminalsForWorktree: (id, options) =>
          OrcaRuntimeWithStopTerminalsForWorktree.prototype.stopTerminalsForWorktree.call(
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this supplies the graph/controller ports reached by the stop method.
            graph as never,
            id,
            options
          ),
        getPtyLivenessVerdict: () => null,
        captureStructuredAgentSessionPresentation: () => ({ raw: null, saved: [] }),
        currentLocalStructuredSessionPresentation: () => null,
        removeCapturedStructuredSessionSavedTabs: () => {},
        retireStructuredAgentSessionTabFromSnapshot: () => true
      } as WorktreeTeardownRuntime
      const result = await killAllProcessesForWorktrees([target], {
        runtime,
        localProvider: provider
      })
      expect([...result.values()]).toEqual([false])
      expect(controllerStop).toHaveBeenCalledWith(
        created.id,
        expect.objectContaining({ expectedIncarnationId: created.incarnationId })
      )
      expect(kill).not.toHaveBeenCalled()
      expect(provider.hasPty(created.id)).toBe(true)
    })

    it('refuses a reused provider-only id before signalling its replacement', async () => {
      const created = await provider.spawn({ cols: 80, rows: 24 })
      ptyIncarnations.set(created.id, 'replacement-incarnation')
      const kill = vi.spyOn(mockProc, 'kill')
      await expect(
        provider.shutdown(created.id, {
          immediate: true,
          expectedIncarnationId: created.incarnationId
        })
      ).rejects.toThrow('replaced')
      expect(kill).not.toHaveBeenCalled()
      expect(provider.hasPty(created.id)).toBe(true)
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

    it('escalates through orphan cleanup when the graceful-deadline sweep it joined is refused', async () => {
      vi.useFakeTimers()
      try {
        let forceAttempts = 0
        const destroySpy = vi.fn()
        const killSpy = vi.fn((signal: string) => {
          if (signal === 'SIGKILL' && forceAttempts++ === 0) {
            throw new Error('transient force-kill failure')
          }
          if (destroySpy.mock.calls.length > 0) {
            throw new Error('killed through a released handle')
          }
        })
        spawnMock.mockReturnValue({ ...mockProc, kill: killSpy, destroy: destroySpy })
        const { id } = await provider.spawn({ cols: 80, rows: 24 })
        const table = Promise.withResolvers<string>()
        readProcessTableMock.mockReturnValueOnce(table.promise)

        const graceful = provider.shutdown(id, { immediate: false })
        await vi.advanceTimersByTimeAsync(LOCAL_PTY_GRACEFUL_FORCE_TIMEOUT_MS)
        provider.killOrphanedPtys(1)
        table.resolve('')

        await vi.waitFor(() => expect(destroySpy).toHaveBeenCalledOnce())
        expect(killSpy.mock.calls).toEqual([['SIGTERM'], ['SIGKILL'], ['SIGKILL']])
        exitCb?.({ exitCode: 137 })
        await graceful
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
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
  })
})
