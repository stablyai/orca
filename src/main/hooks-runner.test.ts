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
    const fs = await import('fs')
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
        'C:\\repo\\feature',
        'pnpm install\npnpm build'
      )

      expect(result).toEqual({
        runnerScriptPath: 'C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.cmd',
        envVars: expect.objectContaining({
          ORCA_ROOT_PATH: '/test/repo',
          ORCA_WORKTREE_PATH: 'C:\\repo\\feature'
        })
      })
      expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
        'C:\\repo\\.git\\worktrees\\feature\\orca\\setup-runner.cmd',
        [
          '@echo off',
          'setlocal EnableExtensions',
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

  it('translates WSL runner paths and env vars to Linux form on Windows', async () => {
    const fs = await import('fs')
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
    const fs = await import('fs')
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
    const fs = await import('fs')

    execFileSyncMock.mockReturnValue(
      '/test/repo/.git/worktrees/feature/orca/issue-command-runner.sh'
    )

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
  })
})
