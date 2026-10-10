import { describe, expect, it, vi } from 'vitest'
import { statSyncMock, spawnMock, wslUncDirectoryExistsAsyncMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { _setWslCachesForTests } from '../wsl'
import { acquireWatcherRemovalGate } from './watcher-removal-gate'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()

  it('passes floating terminal cwds through to the spawned shell', async () => {
    // Why: the floating sentinel has no worktree root; its cwd is validated against trusted-directory grants before reaching pty:spawn.
    registerPtyHandlers(mainWindow as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/tmp/floating-notes',
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })

    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe('/tmp/floating-notes')
  })
  it('rejects a renderer spawn while destructive worktree removal holds the gate', async () => {
    const removal = acquireWatcherRemovalGate('/repo/app')
    await removal.ready
    registerPtyHandlers(mainWindow as never)

    try {
      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          worktreeId: 'repo-1::/repo/app'
        })
      ).rejects.toMatchObject({ code: 'terminal_removal_in_progress' })
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      removal.release()
    }
  })
  it('rejects a sibling-worktree terminal cwd inside a worktree being removed', async () => {
    const removal = acquireWatcherRemovalGate('/repo/app')
    await removal.ready
    registerPtyHandlers(mainWindow as never)

    try {
      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/repo/app/nested',
          worktreeId: 'repo-1::/repo/sibling'
        })
      ).rejects.toMatchObject({ code: 'terminal_removal_in_progress' })
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      removal.release()
    }
    const siblingRemoval = acquireWatcherRemovalGate('/repo/sibling')
    await siblingRemoval.ready
    siblingRemoval.release()
  })
  it('rejects a runtime sibling-worktree cwd inside a removing worktree', async () => {
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    registerPtyHandlers(mainWindow as never, runtime as never)
    const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
      spawn(args: {
        cols: number
        rows: number
        cwd?: string
        worktreeId?: string
        env?: Record<string, string>
      }): Promise<{ id: string }>
    }
    const removal = acquireWatcherRemovalGate('/repo/app')
    await removal.ready

    try {
      await expect(
        controller.spawn({
          cols: 80,
          rows: 24,
          cwd: '/repo/app/nested',
          worktreeId: 'repo-1::/repo/sibling',
          env: {}
        })
      ).rejects.toMatchObject({ code: 'terminal_removal_in_progress' })
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      removal.release()
    }
  })
  it('falls back to the worktree root when a saved local cwd no longer exists', async () => {
    registerPtyHandlers(mainWindow as never)
    // Why: issue #7239 reproduced in a Japanese-named worktree; the fallback must return the selected worktree path verbatim.
    const worktreePath = '/Users/motoki/orca/workspaces/nakamuramotoki/Fableと議論'
    const missingCwd = `${worktreePath}/deleted-folder`
    statSyncMock.mockImplementation((target: string) => {
      if (target === missingCwd) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755 }
    })

    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: missingCwd,
      cwdFallback: 'worktree',
      worktreeId: `repo-1::${worktreePath}`
    })) as { startupCwdFallback?: { kind: string; cwd: string } }

    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe(worktreePath)
    expect(result.startupCwdFallback).toEqual({ kind: 'worktree', cwd: worktreePath })
  })
  it.each(['/home/alice/repo', '/a', '/c'])(
    'keeps an existing POSIX startup cwd for the selected WSL runtime (%s)',
    async (startupCwd) => {
      const originalPlatform = process.platform
      const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-wsl-cwd' })
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      wslUncDirectoryExistsAsyncMock.mockResolvedValue(true)
      statSyncMock.mockImplementation((target: string) => {
        if (target === startupCwd) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return { isDirectory: () => true, mode: 0o755 }
      })

      try {
        installDaemonTestProvider({ spawn: providerSpawn })
        registerPtyHandlers(mainWindow as never)
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: startupCwd,
          cwdFallback: 'worktree',
          worktreeId: 'repo-1::C:\\Users\\alice\\repo',
          projectRuntime: {
            status: 'resolved',
            runtime: {
              kind: 'wsl',
              hostPlatform: 'wsl',
              projectId: 'repo-1',
              distro: 'Ubuntu-24.04',
              reason: 'project-override',
              cacheKey: 'repo-1:wsl'
            }
          }
        })

        const expectedValidationCwd = `\\\\wsl.localhost\\Ubuntu-24.04${startupCwd.replaceAll('/', '\\')}`
        expect(statSyncMock).not.toHaveBeenCalledWith(startupCwd)
        expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledTimes(1)
        expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledWith(expectedValidationCwd)
        expect(providerSpawn).toHaveBeenCalledWith(
          expect.objectContaining({
            cwd: startupCwd,
            shellOverride: 'wsl.exe'
          })
        )
        expect(providerSpawn).toHaveBeenCalledWith(
          expect.not.objectContaining({ prevalidatedCwd: expect.anything() })
        )
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      }
    }
  )
  it('falls back when the selected WSL runtime reports a POSIX cwd missing', async () => {
    const originalPlatform = process.platform
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-wsl-missing-cwd' })
    const worktreePath = 'C:/Users/alice/repo'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(false)

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/a',
        cwdFallback: 'worktree',
        worktreeId: `repo-1::${worktreePath}`,
        projectRuntime: {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'repo-1',
            distro: 'Ubuntu-24.04',
            reason: 'project-override',
            cacheKey: 'repo-1:wsl'
          }
        }
      })) as { startupCwdFallback?: { kind: string; cwd: string } }

      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledTimes(1)
      expect(providerSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: worktreePath }))
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.not.objectContaining({ prevalidatedCwd: expect.anything() })
      )
      expect(result.startupCwdFallback).toEqual({ kind: 'worktree', cwd: worktreePath })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
  it('does not probe or forward local WSL cwd evidence for SSH fallback spawns', async () => {
    const sshSpawn = vi.fn(async () => ({ id: 'ssh-wsl-looking-cwd' }))
    registerSshPtyProvider('ssh-1', {
      spawn: sshSpawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    registerPtyHandlers(mainWindow as never)

    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/a',
      cwdFallback: 'worktree',
      connectionId: 'ssh-1',
      worktreeId: 'repo-1::C:\\Users\\alice\\repo',
      shellOverride: 'wsl.exe',
      projectRuntime: {
        status: 'resolved',
        runtime: {
          kind: 'wsl',
          hostPlatform: 'wsl',
          projectId: 'repo-1',
          distro: 'Ubuntu-24.04',
          reason: 'project-override',
          cacheKey: 'repo-1:wsl'
        }
      }
    })

    expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
    expect(sshSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/a' }))
    expect(sshSpawn).toHaveBeenCalledWith(
      expect.not.objectContaining({ prevalidatedCwd: expect.anything() })
    )
  })
  it('preserves a POSIX WSL cwd when the distro probe is inconclusive', async () => {
    const originalPlatform = process.platform
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-wsl-inconclusive-cwd' })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/a',
        cwdFallback: 'worktree',
        worktreeId: 'repo-1::C:/Users/alice/repo',
        shellOverride: 'wsl.exe'
      })) as { startupCwdFallback?: unknown }

      expect(providerSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/a' }))
      expect(result.startupCwdFallback).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
  it('preserves a POSIX cwd when WSL owns it but no distro can be resolved', async () => {
    const originalPlatform = process.platform
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-wsl-no-distro-cwd' })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    _setWslCachesForTests({ available: true, distros: [] })

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/c',
        cwdFallback: 'worktree',
        worktreeId: 'repo-1::C:/Users/alice/repo',
        shellOverride: 'wsl.exe'
      })) as { startupCwdFallback?: unknown }

      expect(statSyncMock).not.toHaveBeenCalledWith('/c')
      expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
      expect(providerSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/c' }))
      expect(result.startupCwdFallback).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
