import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLocalPtyLaunchPlan } from './local-pty-launch-plan'

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

  it('uses explicit interactive args for the configured default shell', () => {
    const plan = createLocalPtyLaunchPlan(
      { cwd: '/tmp', cols: 80, rows: 24, terminalShellArgs: ['--rcfile', '/tmp/orca rc'] },
      () => ({ getDefaultShell: () => '/bin/bash' })
    )
    expect(plan).toMatchObject({ shellPath: '/bin/bash', shellArgs: ['--rcfile', '/tmp/orca rc'] })
  })

  it('allows an explicit empty argument list for wrapper shells', () => {
    const plan = createLocalPtyLaunchPlan(
      { cwd: '/tmp', cols: 80, rows: 24, terminalShellArgs: [] },
      () => ({ getDefaultShell: () => '/bin/zsh' })
    )
    expect(plan).toMatchObject({ shellArgs: [] })
  })

  it('applies profile args when the shell path was resolved from the setting', () => {
    // Why: the spawn path fills shellOverride from terminalDefaultShell, so a
    // populated override is the normal profile launch, not a one-off pick.
    const plan = createLocalPtyLaunchPlan(
      { cwd: '/tmp', cols: 80, rows: 24, shellOverride: '/bin/bash', terminalShellArgs: [] },
      () => ({ getDefaultShell: () => '/bin/bash' })
    )
    expect(plan).toMatchObject({ shellPath: '/bin/bash', shellArgs: [] })
  })

  it.each([{ command: 'codex' }, { launchAgent: 'codex' as const }])(
    'keeps controlled login args for non-profile launches (%o)',
    (overrides) => {
      const plan = createLocalPtyLaunchPlan(
        {
          cwd: '/tmp',
          cols: 80,
          rows: 24,
          terminalShellArgs: ['--rcfile', '/tmp/orca'],
          ...overrides
        },
        () => ({ getDefaultShell: () => '/bin/zsh' })
      )
      expect('shellArgs' in plan && plan.shellArgs).toEqual(['-l'])
    }
  )
})
