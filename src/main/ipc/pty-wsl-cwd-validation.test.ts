import { describe, expect, it, vi } from 'vitest'
import {
  existsSyncMock,
  statSyncMock,
  spawnMock,
  wslUncDirectoryExistsAsyncMock
} from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { _setWslCachesForTests } from '../wsl'
import { registerPtyHandlers } from './pty'
import { join } from 'node:path'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import { getShellReadyWrapperRoot } from '../providers/local-pty-shell-ready-wrapper-root'

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
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-wsl-unc-cwd' })
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
        cwdFallback: 'worktree',
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
        cwdFallback: 'worktree',
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
        cwdFallback: 'worktree',
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
    const providerSpawn = vi.fn().mockResolvedValue({ id: 'pty-wsl-windows-cwd' })
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
        cwdFallback: 'worktree',
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
        cwdFallback: 'worktree',
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
  it('keeps a missing cwd unchanged without the fallback flag', async () => {
    registerPtyHandlers(mainWindow as never)
    existsSyncMock.mockImplementation((target: string) => target !== '/repo/app/deleted-folder')
    statSyncMock.mockImplementation((target: string) => {
      if (target === '/repo/app/deleted-folder') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755, size: 1 }
    })

    // Why: without the renderer opt-in the provider surfaces its normal missing-directory error — API/runtime callers keep exact cwd semantics.
    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/repo/app/deleted-folder',
        worktreeId: 'repo-1::/repo/app'
      })
    ).rejects.toThrow('Working directory "/repo/app/deleted-folder" does not exist.')

    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('spawns at an existing outside-worktree cwd without falling back (#7685)', async () => {
    registerPtyHandlers(mainWindow as never)

    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      cwd: '/repo/app-other',
      cwdFallback: 'worktree',
      worktreeId: 'repo-1::/repo/app'
    })) as { startupCwdFallback?: unknown }

    const [, , options] = spawnMock.mock.calls.at(-1) as [string, string[], { cwd: string }]
    expect(options.cwd).toBe('/repo/app-other')
    expect(result.startupCwdFallback).toBeUndefined()
  })
  it('ignores the cwd fallback flag for session reattach spawns', async () => {
    registerPtyHandlers(mainWindow as never)
    existsSyncMock.mockImplementation((target: string) => target !== '/repo/app/deleted-folder')
    statSyncMock.mockImplementation((target: string) => {
      if (target === '/repo/app/deleted-folder') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755, size: 1 }
    })

    // Why: a reattach must keep the session's exact cwd; remapping would silently detach the restored terminal from its recorded state.
    await expect(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/repo/app/deleted-folder',
        cwdFallback: 'worktree',
        sessionId: 'session-1',
        worktreeId: 'repo-1::/repo/app'
      })
    ).rejects.toThrow('Working directory "/repo/app/deleted-folder" does not exist.')

    expect(spawnMock).not.toHaveBeenCalled()
  })
  it('rejects missing WSL worktree cwd instead of validating only the fallback Windows cwd', async () => {
    const originalPlatform = process.platform
    const originalUserProfile = process.env.USERPROFILE

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.USERPROFILE = 'C:\\Users\\jinwo'

    // Why: the startup-cwd guard normalizes separators, so the provider sees the forward-slash UNC form.
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
    // Why: this test simulates macOS even when Vitest runs on a Windows host.
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
      expect(options.env.ORCA_ORIG_ZDOTDIR).toBe(process.env.HOME)
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
