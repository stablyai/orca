import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveNiubashPath, resolveNiubashShellPath } from './niubash'
import { resolveWindowsShellLaunchArgs } from './providers/shell-launch/windows/shell-args'
import { shellPathProbe, SHELL_PATH_DELIMITER } from './startup/shell-environment/shell-path-probe'
import { resolveSetupRunnerShell } from './workspace-hooks/worktree-runner-script'

afterEach(() => vi.unstubAllGlobals())

describe('Niubash executable resolution', () => {
  it('uses absolute PATH entries in order, including quoted paths and mixed-case Windows keys', async () => {
    const isExecutable = vi.fn((path: string) => path === 'D:\\Niu Shell\\niu.exe')
    expect(
      await resolveNiubashPath({
        platform: 'win32',
        env: { pAtH: ';.;relative;C:\\missing;"D:\\Niu Shell"' },
        isExecutable
      })
    ).toBe('D:\\Niu Shell\\niu.exe')
    expect(isExecutable.mock.calls).toEqual([['C:\\missing\\niu.exe'], ['D:\\Niu Shell\\niu.exe']])
  })

  it.each(['linux', 'darwin'] as const)(
    'finds the portable niu executable on %s',
    async (platform) => {
      expect(
        await resolveNiubashPath({
          platform,
          env: { PATH: '/usr/local/bin:/usr/bin' },
          isExecutable: (path) => path === '/usr/local/bin/niu'
        })
      ).toBe('/usr/local/bin/niu')
    }
  )

  it('does not invent a shell when PATH contains no niu', async () => {
    expect(
      await resolveNiubashPath({ platform: 'win32', env: {}, isExecutable: () => false })
    ).toBeNull()
    expect(await resolveNiubashShellPath('powershell.exe')).toBe('powershell.exe')
    expect(await resolveNiubashShellPath('D:\\Portable Niu\\niu.exe')).toBe(
      'D:\\Portable Niu\\niu.exe'
    )
  })
})

describe('Niubash terminal launch', () => {
  it('starts an interactive shell in the native cwd without MSYS wrappers or a duplicate startup command', () => {
    expect(
      resolveWindowsShellLaunchArgs(
        'D:\\Niu Shell\\niu.exe',
        'D:\\项目 space',
        'C:\\Users\\test',
        undefined,
        'echo hello'
      )
    ).toEqual({
      shellArgs: ['-i'],
      effectiveCwd: 'D:\\项目 space',
      validationCwd: 'D:\\项目 space'
    })
  })

  it('probes the native semicolon PATH without cygpath', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' })
    expect(shellPathProbe('D:\\Niu Shell\\niu.exe')).toEqual({
      args: ['-ic', `printf '%s' '${SHELL_PATH_DELIMITER}' "$PATH" '${SHELL_PATH_DELIMITER}'`],
      pathDelimiter: ';',
      detached: false
    })
    expect(shellPathProbe('bash.exe').args[1]).toContain('cygpath -wp')
  })

  it('keeps shebang runner execution on niu while plain Windows scripts remain batch runners', () => {
    expect(resolveSetupRunnerShell({ terminalWindowsShell: 'niu.exe' }, 'win32')).toEqual({
      family: 'posix',
      executable: 'niu.exe'
    })
  })
})
