import { createDaemonActiveProviderFixtures } from './pty-ipc-daemon-provider-fixtures'
import { describe, expect, it, vi } from 'vitest'
import {
  statSyncMock,
  spawnMock,
  wslUncDirectoryExistsAsyncMock,
  existsSyncMock
} from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { _setWslCachesForTests } from '../../wsl'
import { acquireWatcherRemovalGate } from '../watcher-removal-gate'
import { registerPtyHandlers } from './register-handlers'
import { join } from 'node:path'
import { getShellReadyWrapperRoot } from '../../providers/local-pty-shell-ready-wrapper-root'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const { makeProjectRuntimeStore } = createDaemonActiveProviderFixtures({ handlers, mainWindow })

  it('passes floating terminal cwds through to the spawned shell', async () => {
    // Floating terminals have no worktree root; trusted-directory grants validate cwd before IPC.
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
    // Preserve Unicode worktree paths verbatim when falling back (#7239).
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
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          undefined,
          undefined,
          undefined,
          makeProjectRuntimeStore({
            projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
          })
        )
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: startupCwd,
          worktreeId: 'repo-1::C:\\Users\\alice\\repo'
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
    const providerSpawn = vi
      .fn()
      .mockResolvedValue({ id: 'pty-wsl-missing-cwd', startupCwdSource: 'request' })
    const worktreePath = 'C:/Users/alice/repo'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(false)

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(
        mainWindow as never,
        undefined,
        undefined,
        undefined,
        undefined,
        makeProjectRuntimeStore({
          projectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
        })
      )
      const result = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/a',
        worktreeId: `repo-1::${worktreePath}`
      })
      if (!result || typeof result !== 'object' || !('startupCwdFallback' in result)) {
        throw new Error('Expected a startup cwd fallback result')
      }

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

describe('PTY WSL working-directory validation', () => {
  const { handlers, mainWindow, installDaemonTestProvider, spawnAndGetCall } = setupPtyIpcSuite()

  it.each([
    {
      exists: true,
      expectedCwd: '/home/alice/repo',
      expectedFallback: undefined
    },
    {
      exists: false,
      expectedCwd: '\\\\wsl.localhost\\Ubuntu\\home\\alice',
      expectedFallback: {
        kind: 'worktree',
        cwd: '\\\\wsl.localhost\\Ubuntu\\home\\alice'
      }
    }
  ])('resolves POSIX cwd existence for a WSL UNC workspace ($exists)', async (testCase) => {
    const originalPlatform = process.platform
    const providerSpawn = vi
      .fn()
      .mockResolvedValue({ id: 'pty-wsl-unc-cwd', startupCwdSource: 'request' })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslUncDirectoryExistsAsyncMock.mockResolvedValueOnce(testCase.exists)
    if (!testCase.exists) {
      wslUncDirectoryExistsAsyncMock.mockResolvedValueOnce(true)
    }

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/home/alice/repo',
        worktreeId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\alice'
      })) as { startupCwdFallback?: { kind: string; cwd: string } }

      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledTimes(testCase.exists ? 1 : 2)
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: testCase.expectedCwd })
      )
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.not.objectContaining({ prevalidatedCwd: expect.anything() })
      )
      expect(result.startupCwdFallback).toEqual(testCase.expectedFallback)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
  it('preserves a missing POSIX cwd when its WSL workspace root is also missing', async () => {
    const originalPlatform = process.platform
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-wsl-missing-root' })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(false)

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/c',
        worktreeId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\alice'
      })) as { startupCwdFallback?: unknown }

      expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledTimes(2)
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.not.objectContaining({ prevalidatedCwd: expect.anything() })
      )
      expect(providerSpawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/c' }))
      expect(result.startupCwdFallback).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
  it('validates a /mnt drive cwd through its native Windows path', async () => {
    const originalPlatform = process.platform
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-wsl-mnt-cwd' })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    _setWslCachesForTests({ available: true, distros: ['Ubuntu'] })

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/mnt/c/Users/alice/repo',
        worktreeId: 'repo-1::C:/Users/alice/repo',
        shellOverride: 'wsl.exe'
      })

      expect(statSyncMock).toHaveBeenCalledWith('C:\\Users\\alice\\repo')
      expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/mnt/c/Users/alice/repo' })
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
  it('still falls back a missing Windows cwd when the selected runtime is WSL', async () => {
    const originalPlatform = process.platform
    const providerSpawn = vi
      .fn()
      .mockResolvedValue({ id: 'pty-wsl-windows-cwd', startupCwdSource: 'request' })
    const worktreePath = 'C:/Users/alice/repo'
    const missingCwd = `${worktreePath}/deleted-folder`
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    statSyncMock.mockImplementation((target: string) => {
      if (target === missingCwd) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755, size: 1 }
    })

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: missingCwd,
        worktreeId: `repo-1::${worktreePath}`,
        shellOverride: 'wsl.exe'
      })) as { startupCwdFallback?: { kind: string; cwd: string } }

      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: worktreePath, shellOverride: 'wsl.exe' })
      )
      expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
      expect(result.startupCwdFallback).toEqual({ kind: 'worktree', cwd: worktreePath })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
  it('probes Git Bash /c as its existing native drive root without falling back', async () => {
    const originalPlatform = process.platform
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-git-bash-cwd' })
    const worktreePath = 'C:/Users/alice/repo'
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      installDaemonTestProvider({ spawn: providerSpawn })
      registerPtyHandlers(mainWindow as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/c',
        worktreeId: `repo-1::${worktreePath}`,
        shellOverride: 'C:\\Program Files\\Git\\bin\\bash.exe'
      })) as { startupCwdFallback?: { kind: string; cwd: string } }

      expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
      expect(statSyncMock).toHaveBeenCalledWith('C:\\')
      expect(statSyncMock).not.toHaveBeenCalledWith('/c')
      expect(providerSpawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/c',
          shellOverride: expect.stringContaining('bash')
        })
      )
      expect(result.startupCwdFallback).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
  it('spawns at an existing outside-worktree cwd without falling back (#7685)', async () => {
    registerPtyHandlers(mainWindow as never)

    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/repo/app-other',
      worktreeId: 'repo-1::/repo/app'
    })) as { startupCwdFallback?: unknown }

    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe('/repo/app-other')
    expect(result.startupCwdFallback).toBeUndefined()
  })
  it('falls back for a caller-named session that has to be created, and says so', async () => {
    registerPtyHandlers(mainWindow as never)
    existsSyncMock.mockImplementation((target: string) => target !== '/repo/app/deleted-folder')
    statSyncMock.mockImplementation((target: string) => {
      if (target === '/repo/app/deleted-folder') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755, size: 1 }
    })

    const result = await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/repo/app/deleted-folder',
      sessionId: 'session-1',
      worktreeId: 'repo-1::/repo/app'
    })

    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe('/repo/app')
    expect(result).toHaveProperty('startupCwdFallback', { kind: 'worktree', cwd: '/repo/app' })
  })
  it('rejects missing WSL worktree cwd instead of validating only the fallback Windows cwd', async () => {
    const originalPlatform = process.platform
    const originalUserProfile = process.env.USERPROFILE

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.USERPROFILE = 'C:\\Users\\jinwo'

    // Startup cwd normalization converts UNC separators before provider validation.
    existsSyncMock.mockImplementation((targetPath: string) => {
      if (targetPath === '//wsl.localhost/Ubuntu/home/jin/missing') {
        return false
      }
      return true
    })

    try {
      registerPtyHandlers(mainWindow as never)

      await expect(
        handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing',
          worktreeId: 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\jin'
        })
      ).rejects.toThrow(
        'Working directory "//wsl.localhost/Ubuntu/home/jin/missing" does not exist.'
      )
      expect(spawnMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE
      } else {
        process.env.USERPROFILE = originalUserProfile
      }
    }
  })
  it('spawns a plain POSIX login shell and queues startup commands for the live session', async () => {
    const originalPlatform = process.platform
    const originalHome = process.env.HOME
    const originalOrcaOrigZdotdir = process.env.ORCA_ORIG_ZDOTDIR
    const originalShell = process.env.SHELL
    const originalZdotdir = process.env.ZDOTDIR

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'darwin'
    })
    // The fixture forces macOS even on Windows test hosts.
    process.env.HOME = '/Users/test'
    delete process.env.ORCA_ORIG_ZDOTDIR
    process.env.SHELL = '/bin/zsh'
    delete process.env.ZDOTDIR

    try {
      const [shell, args, options] = await spawnAndGetCall({
        cwd: '/tmp',
        command: 'printf "hello"'
      })
      expect(shell).toBe('/bin/zsh')
      expect(args).toEqual(['-l'])
      expect(options.env.ZDOTDIR).toBe(join(getShellReadyWrapperRoot(), 'zsh'))
      // Without user zsh startup files, leave ZDOTDIR unset as an ordinary login shell would.
      expect(options.env.ORCA_ORIG_ZDOTDIR).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      if (originalOrcaOrigZdotdir === undefined) {
        delete process.env.ORCA_ORIG_ZDOTDIR
      } else {
        process.env.ORCA_ORIG_ZDOTDIR = originalOrcaOrigZdotdir
      }
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
      if (originalZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = originalZdotdir
      }
    }
  })
})
