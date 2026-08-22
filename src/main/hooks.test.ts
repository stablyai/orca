import type * as GitRunner from './git/runner'

import { describe, expect, it, vi } from 'vitest'
import { makeHookTestRepo } from './hooks-test-fixtures'

// Mock fs used by loadHooks
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  chmodSync: vi.fn()
}))

const { execMock, runWslProcessMock, gitExecFileSyncMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  runWslProcessMock: vi.fn(),
  gitExecFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  exec: execMock,
  execFileSync: vi.fn(),
  // runner.ts imports spawn from child_process transitively.
  spawn: vi.fn()
}))

vi.mock('./wsl/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))

vi.mock('./git/runner', async () => ({
  ...(await vi.importActual<typeof GitRunner>('./git/runner')),
  gitExecFileSync: gitExecFileSyncMock
}))

describe('runHook', () => {
  const makeRepo = (hookSettings?: {
    mode?: 'auto' | 'override'
    setupRunPolicy?: 'ask' | 'run-by-default' | 'skip-by-default'
    scripts?: { setup: string; archive: string }
  }) => makeHookTestRepo(hookSettings)

  it('uses the Windows command shell when running hooks', async () => {
    execMock.mockImplementation((_script, _options, callback) => {
      callback?.(null, '', '')
      return {} as never
    })

    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    const originalComSpec = process.env.ComSpec

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe'

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', 'C:\\repo\\worktree', makeRepo())

      expect(result).toEqual({ success: true, output: '' })
      expect(execMock).toHaveBeenCalledWith(
        'echo hello',
        expect.objectContaining({
          cwd: 'C:\\repo\\worktree',
          shell: 'C:\\Windows\\System32\\cmd.exe'
        }),
        expect.any(Function)
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalComSpec === undefined) {
        delete process.env.ComSpec
      } else {
        process.env.ComSpec = originalComSpec
      }
    }
  })

  it('keeps bash as the hook shell on non-Windows platforms', async () => {
    execMock.mockImplementation((_script, _options, callback) => {
      callback?.(null, '', '')
      return {} as never
    })

    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    const originalShell = process.env.SHELL

    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux'
    })
    process.env.SHELL = '/opt/homebrew/bin/fish'

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', '/repo/worktree', makeRepo())

      expect(result).toEqual({ success: true, output: '' })
      expect(execMock).toHaveBeenCalledWith(
        'echo hello',
        expect.objectContaining({
          cwd: '/repo/worktree',
          shell: '/bin/bash',
          // Setup hooks run unattended: git in them must not pop the OS
          // credential helper's OAuth window and loop it (issue #7652).
          env: expect.objectContaining({
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never'
          })
        }),
        expect.any(Function)
      )
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalShell === undefined) {
        delete process.env.SHELL
      } else {
        process.env.SHELL = originalShell
      }
    }
  })

  it('runs WSL hooks through runWslProcess and translates env paths to Linux', async () => {
    execMock.mockReset()
    runWslProcessMock.mockReset()
    runWslProcessMock.mockResolvedValue({ environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false })

    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\feature', {
        ...makeRepo(),
        path: 'C:\\Users\\jinwo\\git\\orca'
      })

      expect(result).toEqual({ success: true, output: '' })
      expect(runWslProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          distro: 'Ubuntu',
          lane: 'probe',
          script: 'echo hello',
          cwd: '/home/jin/feature',
          // #7652 regression: the unattended WSL hook branch must carry the
          // credential guard into the guest env.
          env: expect.objectContaining({
            ORCA_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            ORCA_WORKTREE_PATH: '/home/jin/feature',
            CONDUCTOR_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            GHOSTX_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never'
          })
        })
      )
      expect(execMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('runs Windows-path hooks through WSL when the project runtime targets WSL', async () => {
    execMock.mockReset()
    runWslProcessMock.mockReset()
    runWslProcessMock.mockResolvedValue({ environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false })

    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook(
        'setup',
        'C:\\Users\\jinwo\\git\\orca-feature',
        {
          ...makeRepo(),
          path: 'C:\\Users\\jinwo\\git\\orca'
        },
        undefined,
        { wslDistro: 'Ubuntu' }
      )

      expect(result).toEqual({ success: true, output: '' })
      expect(runWslProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          distro: 'Ubuntu',
          lane: 'probe',
          script: 'echo hello',
          cwd: '/mnt/c/Users/jinwo/git/orca-feature',
          env: expect.objectContaining({
            ORCA_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            ORCA_WORKTREE_PATH: '/mnt/c/Users/jinwo/git/orca-feature',
            CONDUCTOR_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca',
            GHOSTX_ROOT_PATH: '/mnt/c/Users/jinwo/git/orca'
          })
        })
      )
      expect(execMock).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('writes Windows-path setup runners through WSL git when the project runtime targets WSL', async () => {
    gitExecFileSyncMock.mockReset()
    gitExecFileSyncMock.mockReturnValue('/mnt/c/Users/jinwo/git/orca/.git/orca/setup-runner.sh\n')

    const fs = await import('node:fs')
    const mkdirSyncMock = vi.mocked(fs.mkdirSync)
    const writeFileSyncMock = vi.mocked(fs.writeFileSync)
    const chmodSyncMock = vi.mocked(fs.chmodSync)

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { createSetupRunnerScript } = await import('./worktree-runner-script')
      const result = createSetupRunnerScript(
        {
          ...makeRepo(),
          path: 'C:\\Users\\jinwo\\git\\orca'
        },
        'C:\\Users\\jinwo\\git\\orca-feature',
        'echo hello',
        { wslDistro: 'Ubuntu' }
      )

      expect(gitExecFileSyncMock).toHaveBeenCalledWith(
        ['rev-parse', '--git-path', 'orca/setup-runner.sh'],
        {
          cwd: 'C:\\Users\\jinwo\\git\\orca-feature',
          wslDistro: 'Ubuntu'
        }
      )
      expect(result.runnerScriptPath).toContain('setup-runner.sh')
      expect(result.shell).toEqual({ family: 'posix', executable: 'wsl.exe' })
      expect(mkdirSyncMock).toHaveBeenCalled()
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        expect.stringContaining('setup-runner.sh'),
        '#!/usr/bin/env bash\nset -e\necho hello\n',
        'utf-8'
      )
      expect(chmodSyncMock).toHaveBeenCalledWith(expect.stringContaining('setup-runner.sh'), 0o755)
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('settles WSL hooks when wsl.exe never reports completion', async () => {
    // Why no fake timers: the timeout is now runProcess's own, internal to the
    // mocked runWslProcess -- there is nothing left in hooks.ts to advance.
    execMock.mockReset()
    runWslProcessMock.mockReset()
    runWslProcessMock.mockResolvedValue({ environmentResolved: true, code: null, stdout: '', stderr: '', timedOut: true })

    const fs = await import('node:fs')
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('scripts:\n  setup: |\n    echo hello\n')

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      const { runHook } = await import('./hooks')
      const result = await runHook('setup', '\\\\wsl.localhost\\Ubuntu\\home\\jin\\feature', {
        ...makeRepo(),
        path: 'C:\\Users\\jinwo\\git\\orca'
      })

      expect(result).toMatchObject({
        success: false,
        output: expect.stringContaining('Hook timed out')
      })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })
})
