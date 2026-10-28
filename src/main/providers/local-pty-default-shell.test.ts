import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REMOTE_VIEWER_CLIPBOARD_ENV } from '../../shared/remote-viewer-clipboard-env'
import { finalizeLocalPtySpawnEnvironment } from './local-pty-finalize-environment'
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
    // Profile launches populate shellOverride from settings; it does not identify a one-off shell choice.
    const plan = createLocalPtyLaunchPlan(
      { cwd: '/tmp', cols: 80, rows: 24, shellOverride: '/bin/bash', terminalShellArgs: [] },
      () => ({ getDefaultShell: () => '/bin/bash' })
    )
    expect(plan).toMatchObject({ shellPath: '/bin/bash', shellArgs: [] })
  })

  it.each([{ command: 'codex' }, { launchAgent: 'codex' as const }])(
    'keeps controlled login args for non-profile launches (%o)',
    (overrides) => {
      const spawn = {
        cwd: '/tmp',
        cols: 80,
        rows: 24,
        terminalShellArgs: ['--rcfile', '/tmp/orca'],
        ...overrides
      }
      const getOptions = () => ({ getDefaultShell: () => '/bin/zsh' })
      const plan = createLocalPtyLaunchPlan(spawn, getOptions)
      if (!('shellArgs' in plan)) {
        throw new Error('Expected a POSIX shell launch plan')
      }
      finalizeLocalPtySpawnEnvironment({
        spawn,
        getOptions,
        plan,
        env: { [REMOTE_VIEWER_CLIPBOARD_ENV]: '1' }
      })
      expect(plan.shellArgs).toEqual(['-l'])
    }
  )

  it.for([
    { shell: '/bin/bash', shellArgs: ['--rcfile', 'custom rc'], expected: 'custom:off' },
    { shell: '/bin/zsh', shellArgs: ['-f'], expected: 'unset:off' },
    { shell: '/bin/zsh', shellArgs: [], expected: 'zshrc:off' }
  ])(
    'honors remote profile startup behavior for $shell $shellArgs',
    ({ shell, shellArgs, expected }, { skip }) => {
      if (spawnSync(shell, ['--version']).status !== 0) {
        skip('Shell is not installed')
      }
      const home = mkdtempSync(join(tmpdir(), 'orca-profile-argv-'))
      vi.stubEnv('ORCA_USER_DATA_PATH', home)
      vi.stubEnv('ZDOTDIR', home)
      try {
        writeFileSync(join(home, '.bash_profile'), 'export ORCA_TEST_STARTUP=profile\n')
        writeFileSync(join(home, 'custom rc'), 'export ORCA_TEST_STARTUP=custom\n')
        writeFileSync(join(home, '.zshrc'), 'export ORCA_TEST_STARTUP=zshrc\n')
        const terminalShellArgs = shellArgs.map((arg) =>
          arg === 'custom rc' ? join(home, arg) : arg
        )
        const spawn = { cwd: home, cols: 80, rows: 24, terminalShellArgs }
        const getOptions = () => ({ getDefaultShell: () => shell })
        const plan = createLocalPtyLaunchPlan(spawn, getOptions)
        if (!('shellArgs' in plan)) {
          throw new Error('Expected a POSIX shell launch plan')
        }
        const env = { HOME: home, PATH: '/usr/bin:/bin', [REMOTE_VIEWER_CLIPBOARD_ENV]: '1' }
        finalizeLocalPtySpawnEnvironment({ spawn, getOptions, plan, env })

        const result = spawnSync(
          plan.shellPath,
          [
            ...plan.shellArgs,
            '-i',
            '-c',
            'login=off; if [ -n "${ZSH_VERSION:-}" ]; then [[ -o login ]] && login=on; else shopt -q login_shell && login=on; fi; printf "\\nORCA_STARTUP_RESULT=%s:%s\\n" "${ORCA_TEST_STARTUP:-unset}" "$login"'
          ],
          { env, encoding: 'utf8', timeout: 10_000 }
        )
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout.match(/^ORCA_STARTUP_RESULT=(.*)$/m)?.[1]).toBe(expected)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )
})
