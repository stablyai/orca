import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalPtyLaunchPlan } from './local-pty-launch-plan'
import { getShellLaunchConfig } from './local-pty-shell-ready'

vi.mock('./local-pty-utils', () => ({
  ensureNodePtySpawnHelperExecutable: vi.fn(),
  validateWorkingDirectory: vi.fn()
}))

afterEach(() => vi.unstubAllEnvs())

describe.skipIf(process.platform === 'win32')('default terminal shell', () => {
  it.each(['/bin/bash', '/bin/zsh', '/usr/bin/fish', '/usr/bin/nu'])(
    'uses the configured executable %s',
    (shell) => {
      const plan = createLocalPtyLaunchPlan({ cwd: '/tmp', cols: 80, rows: 24 }, () => ({
        getDefaultShell: () => shell
      }))
      expect(plan).toMatchObject({ shellPath: shell, shellArgs: ['-l'] })
    }
  )

  it('keeps an explicit per-terminal shell ahead of the default', () => {
    const plan = createLocalPtyLaunchPlan(
      { cwd: '/tmp', cols: 80, rows: 24, shellOverride: '/bin/bash' },
      () => ({
        getDefaultShell: () => '/usr/bin/fish'
      })
    )
    expect(plan).toMatchObject({ shellPath: '/bin/bash' })
  })

  it('uses the environment shell when no default is configured', () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const plan = createLocalPtyLaunchPlan({ cwd: '/tmp', cols: 80, rows: 24 }, () => ({
      getDefaultShell: () => ''
    }))
    expect(plan).toMatchObject({ shellPath: '/bin/zsh' })
  })

  it('supports empty shell arguments when configured', () => {
    const plan = createLocalPtyLaunchPlan({ cwd: '/tmp', cols: 80, rows: 24 }, () => ({
      getDefaultShell: () => '/bin/zsh',
      getDefaultShellArgs: () => []
    }))
    expect(plan).toMatchObject({ shellPath: '/bin/zsh', shellArgs: [] })
  })

  it('supports custom flags when configured', () => {
    const plan = createLocalPtyLaunchPlan({ cwd: '/tmp', cols: 80, rows: 24 }, () => ({
      getDefaultShell: () => '/bin/zsh',
      getDefaultShellArgs: () => ['-f', '-i']
    }))
    expect(plan).toMatchObject({ shellPath: '/bin/zsh', shellArgs: ['-f', '-i'] })
  })

  it('defaults shellArgs to login shell -l when unconfigured', () => {
    const plan = createLocalPtyLaunchPlan({ cwd: '/tmp', cols: 80, rows: 24 }, () => ({
      getDefaultShell: () => '/bin/zsh',
      getDefaultShellArgs: () => undefined
    }))
    expect(plan).toMatchObject({ shellPath: '/bin/zsh', shellArgs: ['-l'] })
  })

  it('supports custom shell arguments with bash and fish in launch plan', () => {
    const bashPlan = createLocalPtyLaunchPlan({ cwd: '/tmp', cols: 80, rows: 24 }, () => ({
      getDefaultShell: () => '/bin/bash',
      getDefaultShellArgs: () => ['--noprofile']
    }))
    expect(bashPlan).toMatchObject({ shellPath: '/bin/bash', shellArgs: ['--noprofile'] })

    const fishPlan = createLocalPtyLaunchPlan({ cwd: '/tmp', cols: 80, rows: 24 }, () => ({
      getDefaultShell: () => '/usr/bin/fish',
      getDefaultShellArgs: () => ['-d', '2']
    }))
    expect(fishPlan).toMatchObject({ shellPath: '/usr/bin/fish', shellArgs: ['-d', '2'] })
  })

  it('preserves custom shell arguments in getShellLaunchConfig for bash, fish, and zsh', () => {
    const zshConfig = getShellLaunchConfig('/bin/zsh', ['ready'], undefined, ['-i'])
    expect(zshConfig.args).toEqual(['-i'])

    const bashConfig = getShellLaunchConfig('/bin/bash', ['ready'], undefined, ['--noprofile'])
    expect(bashConfig.args).toEqual(['--rcfile', expect.any(String), '--noprofile'])

    const fishConfig = getShellLaunchConfig('/usr/bin/fish', ['ready'], undefined, ['-d', '2'])
    expect(fishConfig.args?.[0]).toBe('-d')
    expect(fishConfig.args?.[1]).toBe('2')
    expect(fishConfig.args?.[2]).toBe('-C')

    const fishEmptyConfig = getShellLaunchConfig('/usr/bin/fish', ['ready'], undefined, [])
    expect(fishEmptyConfig.args?.[0]).toBe('-C')
  })
})
