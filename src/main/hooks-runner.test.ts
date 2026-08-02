import type { Repo } from '../shared/types'

import { describe, expect, it, vi } from 'vitest'

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn()
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  chmodSync: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFileSync: execFileSyncMock,
  // runner.ts imports these from child_process; stubs prevent
  // "missing export" errors when the mock is resolved transitively.
  execFile: vi.fn(),
  spawn: vi.fn()
}))

describe('createSetupRunnerScript', () => {
  const makeRepo = () =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now()
    }) as unknown as Repo

  it('writes a fail-fast Windows runner that returns after batch commands', async () => {
    const fs = await import('node:fs')
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.cmd')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { createSetupRunnerScript } = await import('./hooks')
      const result = createSetupRunnerScript(
        makeRepo(),
        'C:\\repo\\feature\\',
        'pnpm install\npnpm build'
      )

      expect(result).toEqual({
        runnerScriptPath: 'C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.cmd',
        envVars: expect.objectContaining({
          ORCA_ROOT_PATH: '/test/repo',
          ORCA_WORKTREE_PATH: 'C:\\repo\\feature\\',
          ORCA_WORKSPACE_NAME: 'feature'
        }),
        // Why: native Windows worktrees without a configured setup shell keep the cmd runner.
        shell: { family: 'cmd' }
      })
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        'C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.cmd',
        [
          '@echo off',
          'setlocal EnableExtensions DisableDelayedExpansion',
          'call pnpm install',
          'if errorlevel 1 exit /b %errorlevel%',
          'call pnpm build',
          'if errorlevel 1 exit /b %errorlevel%',
          ''
        ].join('\r\n'),
        'utf-8'
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('converts path env vars to MSYS form for a native Windows Git Bash runner', async () => {
    const fs = await import('node:fs')
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createSetupRunnerScript } = await import('./hooks')
      const result = createSetupRunnerScript(
        { ...makeRepo(), path: 'C:\\Users\\jinwo\\git\\orca' },
        'C:\\repo\\feature',
        'pnpm install',
        undefined,
        { family: 'posix' }
      )

      expect(result).toEqual({
        runnerScriptPath: 'C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        envVars: expect.objectContaining({
          ORCA_ROOT_PATH: '/c/Users/jinwo/git/orca',
          ORCA_WORKTREE_PATH: '/c/repo/feature',
          CONDUCTOR_ROOT_PATH: '/c/Users/jinwo/git/orca',
          GHOSTX_ROOT_PATH: '/c/Users/jinwo/git/orca',
          // Why: a display name, never a path — it must survive the conversion untouched.
          ORCA_WORKSPACE_NAME: 'feature'
        }),
        shell: { family: 'posix' }
      })
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        'C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        '#!/usr/bin/env bash\nset -e\npnpm install\n',
        'utf-8'
      )
      // Why: chmod over a native Windows path is meaningless; only the WSL branch sets the bit.
      expect(vi.mocked(fs.chmodSync)).not.toHaveBeenCalledWith(
        'C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        0o755
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('leaves non-path setup env values alone under a Git Bash runner', async () => {
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createSetupRunnerScript } = await import('./hooks')
      const { TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV } =
        await import('../shared/terminal-git-credential-guard')
      const result = createSetupRunnerScript(
        makeRepo(),
        'C:\\repo\\feature',
        'pnpm install',
        undefined,
        { family: 'posix' }
      )

      expect(result.envVars[TERMINAL_GIT_CREDENTIAL_GUARD_POLICY_ENV]).toBe('guard')
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps native Windows env vars in Windows form for the default cmd runner', async () => {
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.cmd')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })

    try {
      const { createSetupRunnerScript } = await import('./hooks')
      const result = createSetupRunnerScript(
        { ...makeRepo(), path: 'C:\\Users\\jinwo\\git\\orca' },
        'C:\\repo\\feature',
        'pnpm install'
      )

      expect(result.envVars).toEqual(
        expect.objectContaining({
          ORCA_ROOT_PATH: 'C:\\Users\\jinwo\\git\\orca',
          ORCA_WORKTREE_PATH: 'C:\\repo\\feature'
        })
      )
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('preserves exclamation marks in Windows runner script lines', async () => {
    const { buildWindowsRunnerScript } = await import('./hooks')

    const runner = buildWindowsRunnerScript('echo hello!world!')

    // Why: launchers invoke the runner under cmd /v:on, so the runner must disable delayed
    // expansion itself or `!world!` is consumed as a variable reference.
    expect(runner).toContain('setlocal EnableExtensions DisableDelayedExpansion')
    expect(runner).toContain('call echo hello!world!')
  })

  it('derives ORCA_WORKSPACE_NAME from a POSIX worktree path', async () => {
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('/test/repo/.git/worktrees/feature/orca/setup-runner.sh')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })

    try {
      const { createSetupRunnerScript } = await import('./hooks')
      const result = createSetupRunnerScript(makeRepo(), '/test/repo-feature', 'pnpm install')

      expect(result.envVars).toEqual(
        expect.objectContaining({
          ORCA_WORKTREE_PATH: '/test/repo-feature',
          ORCA_WORKSPACE_NAME: 'repo-feature'
        })
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('translates WSL runner paths and env vars to Linux form on Windows', async () => {
    const fs = await import('node:fs')
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('/home/jin/.git/worktrees/feature/orca/setup-runner.sh')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { createSetupRunnerScript } = await import('./hooks')
      const result = createSetupRunnerScript(
        {
          ...makeRepo(),
          path: 'C:\\Users\\jinwo\\git\\orca'
        },
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\feature',
        'pnpm install'
      )

      expect(result).toEqual({
        runnerScriptPath:
          '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        envVars: expect.objectContaining({
          ORCA_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
          ORCA_WORKTREE_PATH: '/home/jin/feature',
          ORCA_WORKSPACE_NAME: 'feature',
          CONDUCTOR_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
          GHOSTX_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca'
        })
      })
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        '#!/usr/bin/env bash\nset -e\npnpm install\n',
        'utf-8'
      )
      expect(vi.mocked(fs.chmodSync)).toHaveBeenCalledWith(
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        0o755
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('translates WSL env vars to Linux paths when the worktree lives on a WSL UNC path', async () => {
    const fs = await import('node:fs')
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('/home/jin/repo/.git/worktrees/feature/orca/setup-runner.sh')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { createSetupRunnerScript } = await import('./hooks')
      const result = createSetupRunnerScript(
        makeRepo(),
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\feature',
        'pnpm install'
      )

      expect(result).toEqual({
        runnerScriptPath:
          '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        envVars: expect.objectContaining({
          ORCA_ROOT_PATH: '/test/repo',
          ORCA_WORKTREE_PATH: '/home/jin/repo/feature',
          ORCA_WORKSPACE_NAME: 'feature',
          CONDUCTOR_ROOT_PATH: '/test/repo',
          GHOSTX_ROOT_PATH: '/test/repo'
        })
      })
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        '#!/usr/bin/env bash\nset -e\npnpm install\n',
        'utf-8'
      )
      expect(vi.mocked(fs.chmodSync)).toHaveBeenCalledWith(
        '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.sh',
        0o755
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})

describe('createIssueCommandRunnerScript', () => {
  const makeRepo = () =>
    ({
      id: 'test-id',
      path: '/test/repo',
      displayName: 'Test Repo',
      badgeColor: '#000',
      addedAt: Date.now()
    }) as unknown as Repo

  it('writes a POSIX runner under the worktree git dir for long issue commands', async () => {
    const fs = await import('node:fs')
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue(
      '/test/repo/.git/worktrees/feature/orca/issue-command-runner.sh'
    )
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })

    try {
      const { createIssueCommandRunnerScript } = await import('./hooks')
      const result = createIssueCommandRunnerScript(
        makeRepo(),
        '/test/repo-feature',
        'codex exec "long command"\nclaude -p "review it"'
      )

      expect(result).toEqual({
        runnerScriptPath: '/test/repo/.git/worktrees/feature/orca/issue-command-runner.sh',
        envVars: expect.objectContaining({
          ORCA_ROOT_PATH: '/test/repo',
          ORCA_WORKTREE_PATH: '/test/repo-feature'
        })
      })
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        '/test/repo/.git/worktrees/feature/orca/issue-command-runner.sh',
        '#!/usr/bin/env bash\nset -e\ncodex exec "long command"\nclaude -p "review it"\n',
        'utf-8'
      )
      expect(vi.mocked(fs.chmodSync)).toHaveBeenCalledWith(
        '/test/repo/.git/worktrees/feature/orca/issue-command-runner.sh',
        0o755
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('carries the WSL launch shell for a Windows-drive worktree routed through WSL', async () => {
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('/mnt/c/repo/.git/orca/issue-command-runner.sh')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { createIssueCommandRunnerScript } = await import('./hooks')
      const result = createIssueCommandRunnerScript(
        makeRepo(),
        'C:\\repo\\feature',
        'codex exec "long command"',
        { wslDistro: 'Ubuntu' }
      )

      // Why: the runner path is written back in native Windows form, so the launch needs /mnt again.
      expect(result.runnerScriptPath).toBe('C:\\repo\\.git\\orca\\issue-command-runner.sh')
      expect(result.shell).toEqual({ family: 'posix', executable: 'wsl.exe' })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('keeps native Windows issue runners on the cmd launch shell', async () => {
    const originalPlatform = process.platform

    execFileSyncMock.mockReturnValue('C:\\repo\\.git\\orca\\issue-command-runner.cmd')
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { createIssueCommandRunnerScript } = await import('./hooks')
      const result = createIssueCommandRunnerScript(makeRepo(), 'C:\\repo\\feature', 'pnpm install')

      expect(result.shell).toEqual({ family: 'cmd' })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})
