import type * as GitRunner from './git/runner'

import { describe, expect, it, vi } from 'vitest'
import { makeHookTestRepo } from './hooks-test-fixtures'

// Mock fs used by the runner-script writers
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

const { gitExecFileSyncMock } = vi.hoisted(() => ({
  gitExecFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  // runner.ts imports spawn from child_process transitively.
  spawn: vi.fn()
}))

vi.mock('./git/runner', async () => ({
  ...(await vi.importActual<typeof GitRunner>('./git/runner')),
  gitExecFileSync: gitExecFileSyncMock
}))

describe('runner script builders', () => {
  it('builds Windows runners for newline-heavy scripts without line-array splitting', async () => {
    const { buildWindowsRunnerScript } = await import('./setup-runner-script-text')
    const script = `${'\r\n'.repeat(10_000)}pnpm install\r\nnpm run build\n`
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const replaceSpy = vi.spyOn(String.prototype, 'replace')

    try {
      const result = buildWindowsRunnerScript(script)

      expect(
        result.startsWith('@echo off\r\nsetlocal EnableExtensions DisableDelayedExpansion\r\n')
      ).toBe(true)
      expect(result).toContain('call pnpm install\r\nif errorlevel 1 exit /b %errorlevel%')
      expect(result).toContain('call npm run build\r\nif errorlevel 1 exit /b %errorlevel%')
      const usedLineSplit = splitSpy.mock.calls.some(
        ([separator]) =>
          (typeof separator === 'string' && separator === '\n') ||
          (separator instanceof RegExp && separator.source === '\\r?\\n')
      )
      const usedNewlineReplace = replaceSpy.mock.calls.some(
        ([pattern]) =>
          pattern instanceof RegExp && (pattern.source === '\\r?\\n' || pattern.source === '\\r\\n')
      )
      expect(usedLineSplit).toBe(false)
      expect(usedNewlineReplace).toBe(false)
    } finally {
      splitSpy.mockRestore()
      replaceSpy.mockRestore()
    }
  })

  it('builds POSIX runners without regex-wide CRLF normalization', async () => {
    const { buildPosixRunnerScript } = await import('./setup-runner-script-text')
    const script = `${'echo setup\r\n'.repeat(10_000)}echo done`
    const replaceSpy = vi.spyOn(String.prototype, 'replace')

    try {
      const result = buildPosixRunnerScript(script)

      expect(result.startsWith('#!/usr/bin/env bash\nset -e\necho setup\n')).toBe(true)
      expect(result.endsWith('echo done\n')).toBe(true)
      const usedCrlfReplace = replaceSpy.mock.calls.some(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n'
      )
      expect(usedCrlfReplace).toBe(false)
    } finally {
      replaceSpy.mockRestore()
    }
  })
})

describe('createSetupRunnerScript', () => {
  const makeRepo = (setupAgentStartupPolicy?: 'start-immediately' | 'wait-for-setup') =>
    makeHookTestRepo({
      mode: 'auto',
      setupAgentStartupPolicy,
      scripts: { setup: '', archive: '' }
    })

  it('writes POSIX setup runners for shebang-declared scripts on native Windows paths', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\setup-runner.sh\n')
    const fs = await import('node:fs')
    const writeFileSyncMock = vi.mocked(fs.writeFileSync)
    const chmodSyncMock = vi.mocked(fs.chmodSync)
    writeFileSyncMock.mockClear()
    chmodSyncMock.mockClear()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createSetupRunnerScript } = await import('./worktree-runner-script')
      const result = createSetupRunnerScript(
        makeRepo(),
        'C:\\repo-worktree',
        '#!/usr/bin/env bash\r\npnpm install\r\nnpm run build',
        undefined,
        { family: 'posix' }
      )

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
        { cwd: 'C:\\repo-worktree' }
      )
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        'C:\\repo\\.git\\orca\\setup-runner.sh',
        '#!/usr/bin/env bash\nset -e\npnpm install\nnpm run build\n',
        'utf-8'
      )
      expect(chmodSyncMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.sh',
        shell: { family: 'posix' }
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps batch setup scripts on cmd.exe when the terminal is Git Bash', async () => {
    // Regression (#6967): a Git Bash terminal preference used to hand pre-existing
    // batch setup scripts to bash, where `copy`/`xcopy`/`if errorlevel` do not exist.
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\setup-runner.cmd\n')
    const fs = await import('node:fs')
    const writeFileSyncMock = vi.mocked(fs.writeFileSync)
    writeFileSyncMock.mockClear()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createSetupRunnerScript } = await import('./worktree-runner-script')
      const result = createSetupRunnerScript(
        makeRepo(),
        'C:\\repo-worktree',
        'copy .env.example .env\r\nxcopy /E assets dist',
        undefined,
        { family: 'posix' }
      )

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/setup-runner.cmd'],
        { cwd: 'C:\\repo-worktree' }
      )
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        'C:\\repo\\.git\\orca\\setup-runner.cmd',
        expect.stringContaining('call copy .env.example .env\r\n'),
        'utf-8'
      )
      expect(result).toMatchObject({
        runnerScriptPath: 'C:\\repo\\.git\\orca\\setup-runner.cmd',
        // Why: `shell` is the pane that types the launch command — still Git Bash here. The
        // runner's own .cmd extension is what says the file is batch.
        shell: { family: 'posix' }
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('hands a Git Bash pane a launch command MSYS cannot rewrite for a cmd runner', async () => {
    // Regression (#6896): `cmd.exe /c "C:\...\setup-runner.cmd"` typed into Git Bash has its
    // `/c` switch rewritten into a drive path, so cmd opens interactively and setup never runs.
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\setup-runner.cmd\n')
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createSetupRunnerScript } = await import('./worktree-runner-script')
      const { buildSetupRunnerCommand } = await import('../shared/setup-runner-command')
      const result = createSetupRunnerScript(
        makeRepo(),
        'C:\\repo-worktree',
        'copy .env.example .env',
        undefined,
        { family: 'posix' }
      )

      const command = buildSetupRunnerCommand(result.runnerScriptPath, 'windows', result.shell)

      expect(command).not.toContain('cmd.exe /c')
      // Why: the batch runner must never be handed to bash either.
      expect(command).not.toContain('bash ')
      expect(command).toContain('powershell.exe')
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('replays interpreter flags declared on the shebang line', async () => {
    // Regression: the runner is launched as `bash <path>`, so `-euo pipefail` on the script's
    // own `#!` line never reaches the interpreter unless the runner re-applies it.
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\setup-runner.sh\n')
    const fs = await import('node:fs')
    const writeFileSyncMock = vi.mocked(fs.writeFileSync)
    writeFileSyncMock.mockClear()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createSetupRunnerScript } = await import('./worktree-runner-script')
      createSetupRunnerScript(
        makeRepo(),
        'C:\\repo-worktree',
        '#!/usr/bin/env -S bash -euo pipefail\nmake build | tee build.log',
        undefined,
        { family: 'posix' }
      )

      expect(writeFileSyncMock).toHaveBeenCalledWith(
        'C:\\repo\\.git\\orca\\setup-runner.sh',
        '#!/usr/bin/env bash\nset -e\nset -euo pipefail\nmake build | tee build.log\n',
        'utf-8'
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('preserves cmd.exe setup runner semantics for configured cmd users', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\setup-runner.cmd\n')
    const fs = await import('node:fs')
    const writeFileSyncMock = vi.mocked(fs.writeFileSync)
    writeFileSyncMock.mockClear()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createSetupRunnerScript } = await import('./worktree-runner-script')
      const result = createSetupRunnerScript(
        makeRepo(),
        'C:\\repo-worktree',
        'pnpm install\nnpm run build',
        undefined,
        { family: 'cmd' }
      )

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/setup-runner.cmd'],
        { cwd: 'C:\\repo-worktree' }
      )
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        'C:\\repo\\.git\\orca\\setup-runner.cmd',
        expect.stringContaining('call pnpm install\r\nif errorlevel 1 exit /b %errorlevel%'),
        'utf-8'
      )
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        'C:\\repo\\.git\\orca\\setup-runner.cmd',
        expect.stringContaining('call npm run build\r\nif errorlevel 1 exit /b %errorlevel%'),
        'utf-8'
      )
      expect(result.shell).toEqual({ family: 'cmd' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps POSIX runner behavior on POSIX platforms', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('/test/repo/.git/orca/setup-runner.sh\n')
    const fs = await import('node:fs')
    const writeFileSyncMock = vi.mocked(fs.writeFileSync)
    const chmodSyncMock = vi.mocked(fs.chmodSync)
    writeFileSyncMock.mockClear()
    chmodSyncMock.mockClear()
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })

    try {
      const { createSetupRunnerScript } = await import('./worktree-runner-script')
      const result = createSetupRunnerScript(makeRepo(), '/test/worktree', 'pnpm install')

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
        { cwd: '/test/worktree' }
      )
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        '/test/repo/.git/orca/setup-runner.sh',
        '#!/usr/bin/env bash\nset -e\npnpm install\n',
        'utf-8'
      )
      expect(chmodSyncMock).toHaveBeenCalledWith('/test/repo/.git/orca/setup-runner.sh', 0o755)
      expect(result.shell).toBeUndefined()
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('omits waitForAgentStartup unless the repo explicitly waits for setup', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('/test/repo/.git/orca/setup-runner.sh\n')
    const { createSetupRunnerScript } = await import('./worktree-runner-script')

    expect(
      createSetupRunnerScript(makeRepo(), '/test/worktree', 'echo setup').waitForAgentStartup
    ).toBeUndefined()
    expect(
      createSetupRunnerScript(makeRepo('start-immediately'), '/test/worktree', 'echo setup')
        .waitForAgentStartup
    ).toBeUndefined()
    expect(
      createSetupRunnerScript(makeRepo('wait-for-setup'), '/test/worktree', 'echo setup')
        .waitForAgentStartup
    ).toBe(true)
  })

  it('marks setup-runner terminals for the always-on credential guard', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('/test/repo/.git/orca/setup-runner.sh\n')
    const { createSetupRunnerScript } = await import('./worktree-runner-script')

    const setup = createSetupRunnerScript(makeRepo(), '/test/worktree', 'git fetch')

    expect(setup.envVars).toMatchObject({
      ORCA_ROOT_PATH: '/test/repo',
      ORCA_WORKTREE_PATH: '/test/worktree',
      ORCA_INTERNAL_TERMINAL_GIT_CREDENTIAL_GUARD_POLICY: 'guard'
    })
  })
})

describe('resolveSetupRunnerShell', () => {
  const installedGitBash = {
    resolveGitBashShellPath: () => 'C:\\Program Files\\Git\\bin\\bash.exe'
  }

  it('maps git-bash to POSIX setup launch metadata on Windows', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')

    expect(
      resolveSetupRunnerShell({ terminalWindowsShell: 'git-bash' }, 'win32', installedGitBash)
    ).toEqual({
      family: 'posix'
    })
  })

  it('falls back to the cmd runner when the git-bash setting has no installed Git Bash', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')

    expect(
      resolveSetupRunnerShell({ terminalWindowsShell: 'git-bash' }, 'win32', {
        resolveGitBashShellPath: () => null
      })
    ).toEqual({ family: 'cmd' })
  })

  it('keeps the cmd runner for a non-Git bash such as Cygwin', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')

    expect(
      resolveSetupRunnerShell({ terminalWindowsShell: 'C:\\cygwin64\\bin\\bash.exe' }, 'win32', {
        resolveGitBashShellPath: () => null
      })
    ).toEqual({ family: 'cmd' })
  })

  it('keeps the cmd runner for a bare bash whose flavor cannot be resolved', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')

    expect(
      resolveSetupRunnerShell({ terminalWindowsShell: 'bash' }, 'win32', {
        resolveGitBashShellPath: () => null
      })
    ).toEqual({ family: 'cmd' })
  })

  it('uses the POSIX runner for a bare bash that resolves to Git Bash', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')

    expect(
      resolveSetupRunnerShell({ terminalWindowsShell: 'bash' }, 'win32', installedGitBash)
    ).toEqual({ family: 'posix' })
  })

  it('uses the POSIX runner for an extension-less Git Bash path', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')

    expect(
      resolveSetupRunnerShell(
        { terminalWindowsShell: 'C:\\Program Files\\Git\\bin\\bash' },
        'win32',
        installedGitBash
      )
    ).toEqual({ family: 'posix' })
  })

  it('preserves the existing cmd runner for PowerShell terminals', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')

    expect(
      resolveSetupRunnerShell(
        {
          terminalWindowsShell: 'powershell.exe',
          terminalWindowsPowerShellImplementation: 'pwsh.exe'
        },
        'win32',
        installedGitBash
      )
    ).toEqual({ family: 'cmd' })
  })

  it('preserves cmd setup compatibility when a Windows-host project has a WSL shell setting', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')

    expect(
      resolveSetupRunnerShell({ terminalWindowsShell: 'wsl.exe' }, 'win32', installedGitBash)
    ).toEqual({ family: 'cmd' })
  })

  it('classifies an installed explicit Git Bash executable as a POSIX runner', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')
    const { resolveWindowsGitBashShellPath } = await import('./git-bash')

    expect(
      resolveSetupRunnerShell(
        { terminalWindowsShell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
        'win32',
        {
          resolveGitBashShellPath: (shell) =>
            resolveWindowsGitBashShellPath(shell, { platform: 'win32', exists: () => true })
        }
      )
    ).toEqual({ family: 'posix' })
  })

  it('falls back to the cmd runner when the explicit Git Bash path no longer exists', async () => {
    const { resolveSetupRunnerShell } = await import('./worktree-runner-script')
    const { resolveWindowsGitBashShellPath } = await import('./git-bash')

    // Regression: a stale configured path used to commit setup to a .sh runner the
    // PTY could never spawn, hanging wait-for-setup until the 2h timeout.
    expect(
      resolveSetupRunnerShell(
        { terminalWindowsShell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
        'win32',
        {
          resolveGitBashShellPath: (shell) =>
            resolveWindowsGitBashShellPath(shell, { platform: 'win32', exists: () => false })
        }
      )
    ).toEqual({ family: 'cmd' })
  })
})
