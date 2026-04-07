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
})
