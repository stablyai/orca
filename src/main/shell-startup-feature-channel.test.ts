import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from './pty/posix-shell-startup-command'
import { selectShellStartupFeatures } from './shell-startup-features'
import { prependOrcaCliDirToChildPath } from './cli/orca-cli-child-path'
import { runZshPty } from './zsh-startup-hook-pty-harness'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from './shell-templates'
import {
  importFreshLocalPtyShellReady,
  restoreUserDataPathAfterEach,
  setTestUserDataPath
} from './providers/local-pty-shell-ready-test-harness'

restoreUserDataPathAfterEach()

const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const ZSH_PATH = hasZsh
  ? (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout || '').trim()
  : ''
const itWithZsh = hasZsh ? it : it.skip
const describePosix = process.platform === 'win32' ? describe.skip : describe

const PLAIN_PANE = {
  hasStartupCommand: false,
  waitsForShellReady: false,
  emitsStartupIdentity: false
}

describe('shell startup feature selection', () => {
  it('ignores an inherited ORCA_SHELL_FEATURES in the spawn env', () => {
    expect(
      selectShellStartupFeatures({
        shellPath: '/bin/zsh',
        env: { ORCA_SHELL_FEATURES: 'overlay,markers,ready,identity,history' },
        ...PLAIN_PANE
      })
    ).toEqual([])
  })

  it('cannot be turned off for a pane that needs a feature', () => {
    expect(
      selectShellStartupFeatures({
        shellPath: '/bin/zsh',
        env: { ORCA_SHELL_FEATURES: '', ORCA_HISTFILE: '/tmp/wt/zsh_history' },
        ...PLAIN_PANE
      })
    ).toEqual(['history'])
  })

  it('gives a history-only pane no command markers', () => {
    expect(
      selectShellStartupFeatures({
        shellPath: '/bin/zsh',
        env: { ORCA_HISTFILE: '/tmp/wt/zsh_history' },
        ...PLAIN_PANE
      })
    ).not.toContain('markers')
  })

  it('keeps markers on a pane that already had them', () => {
    expect(
      selectShellStartupFeatures({
        shellPath: '/bin/zsh',
        env: { ORCA_CODEX_HOME: '/tmp/codex' },
        ...PLAIN_PANE
      })
    ).toContain('markers')
  })

  it('does not wrap bash for history alone', () => {
    expect(
      selectShellStartupFeatures({
        shellPath: '/bin/bash',
        env: { ORCA_HISTFILE: '/tmp/wt/bash_history' },
        ...PLAIN_PANE
      })
    ).toEqual([])
  })
})

describePosix('zsh launch config', () => {
  let userDataPath = ''
  let previousFeatures: string | undefined

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-feature-channel-'))
    setTestUserDataPath(userDataPath)
    previousFeatures = process.env.ORCA_SHELL_FEATURES
  })

  afterEach(() => {
    if (previousFeatures === undefined) {
      delete process.env.ORCA_SHELL_FEATURES
    } else {
      process.env.ORCA_SHELL_FEATURES = previousFeatures
    }
    chmodSync(userDataPath, 0o755)
    rmSync(userDataPath, { recursive: true, force: true })
  })

  itWithZsh.each([false, true])(
    'restores this app CLI after zsh startup resets PATH and replaces prompt hooks %s',
    async (replacePromptHooks) => {
      const cliBin = join(userDataPath, 'cli', 'bin')
      const ambientBin = join(userDataPath, 'ambient-bin')
      mkdirSync(cliBin, { recursive: true })
      mkdirSync(ambientBin)
      for (const bin of [cliBin, ambientBin]) {
        const launcher = join(bin, 'orca-dev')
        writeFileSync(launcher, '#!/bin/sh\nexit 0\n')
        chmodSync(launcher, 0o755)
      }
      writeFileSync(
        join(userDataPath, '.zshrc'),
        `export PATH="$HOME/ambient-bin:/usr/bin:/bin:$HOME/cli/bin"\n${replacePromptHooks ? 'precmd_functions=()\n' : ''}`
      )
      const env: Record<string, string> = {
        ...process.env,
        HOME: userDataPath,
        USERPROFILE: userDataPath,
        PATH: `${ambientBin}:/usr/bin:/bin`
      }
      const launcher = prependOrcaCliDirToChildPath(env, { isPackaged: false, userDataPath })
      const features = selectShellStartupFeatures({
        shellPath: ZSH_PATH,
        env,
        ...PLAIN_PANE,
        hasStartupCommand: true
      })
      const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellLaunchConfig(ZSH_PATH, features)
      const result = await runZshPty({
        env: { ...env, ...config.env },
        commands: ['ORCA_LOOKUP=$(command -v orca-dev)'],
        report: ['ORCA_LOOKUP']
      })
      expect(result.values.ORCA_LOOKUP).toBe(launcher)
    }
  )

  it('publishes exactly the selected features, whatever process.env holds', async () => {
    process.env.ORCA_SHELL_FEATURES = 'overlay,markers,ready,identity'
    const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getShellLaunchConfig('/bin/zsh', ['history'])

    expect(config.env.ORCA_SHELL_FEATURES).toBe('history')
  })

  it('wraps a startup-only command without enabling shell readiness', async () => {
    const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getShellLaunchConfig('/bin/zsh', [], 'codex')

    expect(config.env.ORCA_SHELL_FEATURES).toBe('startup')
    expect(config.env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe('codex')
    expect(config.supportsReadyMarker).toBe(false)
  })

  it('falls back to plain login zsh when the wrapper tree cannot be written', async () => {
    chmodSync(userDataPath, 0o500)
    if (
      spawnSync('sh', ['-c', `touch ${JSON.stringify(join(userDataPath, 'probe'))}`]).status === 0
    ) {
      return // running with write access regardless of mode (e.g. root)
    }
    const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getShellLaunchConfig('/bin/zsh', ['history'])

    expect(config).toEqual({
      args: ['-l'],
      env: {},
      supportsReadyMarker: false
    })
  })

  it('does not treat another terminal’s hijacked ZDOTDIR as the user config dir', async () => {
    // Other terminals may own ZDOTDIR; reject only positively identified Orca or empty directories.
    const home = mkdtempSync(join(tmpdir(), 'orca-stacked-zdotdir-'))
    const foreignWrapper = join(home, 'other-terminal', 'zsh')
    mkdirSync(foreignWrapper, { recursive: true })
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = foreignWrapper
    process.env.HOME = home
    try {
      const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()

      // An absent original ZDOTDIR must stay absent, rather than becoming HOME.
      expect(getShellLaunchConfig('/bin/zsh', ['history']).env.ORCA_ORIG_ZDOTDIR).toBeUndefined()

      // The marker identifies ownership even without an Orca-shaped path.
      writeFileSync(join(foreignWrapper, '.zshrc'), '')
      writeFileSync(join(foreignWrapper, ZSH_WRAPPER_DIR_MARKER_FILE), '')
      const stamped = await importFreshLocalPtyShellReady()
      expect(
        stamped.getShellLaunchConfig('/bin/zsh', ['history']).env.ORCA_ORIG_ZDOTDIR
      ).toBeUndefined()

      rmSync(join(foreignWrapper, ZSH_WRAPPER_DIR_MARKER_FILE))
      const real = await importFreshLocalPtyShellReady()
      expect(real.getShellLaunchConfig('/bin/zsh', ['history']).env.ORCA_ORIG_ZDOTDIR).toBe(
        foreignWrapper
      )
    } finally {
      if (previousZdotdir === undefined) {
        delete process.env.ZDOTDIR
      } else {
        process.env.ZDOTDIR = previousZdotdir
      }
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describePosix('epilogue under hostile user shell options', () => {
  let userDataPath = ''
  let home = ''

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-feature-channel-options-'))
    setTestUserDataPath(userDataPath)
    home = mkdtempSync(join(tmpdir(), 'orca-feature-options-home-'))
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  // User options affect the deferred hook: NO_UNSET rejects absent variables; KSH_ARRAYS is zero-based.
  it.each(['no_unset', 'ksh_arrays'])(
    'still runs every feature when the user set %s',
    async (option) => {
      if (!hasZsh) {
        return
      }
      const scoped = join(home, 'orca-history', 'zsh_history')
      const opencodeDir = join(home, 'opencode-overlay')
      writeFileSync(join(home, '.zshrc'), `setopt ${option}\n`)
      // overlay is the first token, exposing KSH_ARRAYS subscript errors.
      const spawnEnv: Record<string, string> = {
        HOME: home,
        ORCA_HISTFILE: scoped,
        ORCA_OPENCODE_CONFIG_DIR: opencodeDir
      }
      const features = selectShellStartupFeatures({
        shellPath: ZSH_PATH,
        env: spawnEnv,
        hasStartupCommand: true,
        waitsForShellReady: true,
        emitsStartupIdentity: true
      })
      const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()
      const launch = getShellLaunchConfig(ZSH_PATH, features)

      // A -c shell never reaches precmd; exercise the hook through a PTY.
      const { values } = await runZshPty({
        env: {
          PATH: '/usr/bin:/bin',
          ...spawnEnv,
          ...launch.env,
          ORCA_ORIG_ZDOTDIR: home
        },
        report: ['LINEINIT', 'PRECMD', 'OPENCODE_CONFIG_DIR', 'ZDOTDIR', 'HISTFILE'],
        commands: [
          'LINEINIT="${widgets[zle-line-init]:-none}"; PRECMD="${precmd_functions[*]:-none}"'
        ]
      })

      expect(values.LINEINIT).toBe('user:__orca_prompt_mark')
      expect(values.PRECMD).toContain('__orca_osc133_precmd')
      expect(values.OPENCODE_CONFIG_DIR).toBe(opencodeDir)
      expect(values.ZDOTDIR).toBe(home)
      expect(values.HISTFILE).toBe(scoped)
    }
  )
})

function makeUserHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'orca-feature-home-'))
  for (const file of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
    writeFileSync(join(home, file), `print -r -- "RAN=${file}"\n`)
  }
  return home
}

describePosix('history-only pane in a real zsh', () => {
  let userDataPath = ''
  let home = ''

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-feature-channel-live-'))
    setTestUserDataPath(userDataPath)
    home = makeUserHome()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  function withoutInheritedZdotdir(env: Record<string, string>): Record<string, string> {
    const { ORCA_ORIG_ZDOTDIR: _inherited, ...rest } = env
    return rest
  }

  async function launchHistoryOnly(): Promise<{
    args: string[]
    env: Record<string, string>
    zdotdir: string
  }> {
    const scoped = join(home, 'orca-history', 'zsh_history')
    const spawnEnv: Record<string, string> = {
      HOME: home,
      HISTFILE: scoped,
      ORCA_HISTFILE: scoped
    }
    const features = selectShellStartupFeatures({
      shellPath: ZSH_PATH,
      env: spawnEnv,
      ...PLAIN_PANE
    })
    expect(features).toEqual(['history'])
    const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()
    const launch = getShellLaunchConfig(ZSH_PATH, features)
    return {
      args: launch.args ?? ['-l'],
      env: {
        PATH: '/usr/bin:/bin',
        ...spawnEnv,
        // This test home has no ZDOTDIR; do not inherit the developer's config.
        ...withoutInheritedZdotdir(launch.env)
      },
      zdotdir: launch.env.ZDOTDIR
    }
  }

  itWithZsh('unsets the feature channel for the shell and for a grandchild', async () => {
    const { args, env } = await launchHistoryOnly()

    const output = execFileSync(
      ZSH_PATH,
      [
        ...args,
        '-i',
        '-c',
        `print -r -- "SELF=[\${ORCA_SHELL_FEATURES:-}]"; zsh -c 'printenv ORCA_SHELL_FEATURES; print -r -- CHILD_CLEAN'`
      ],
      { encoding: 'utf8', timeout: 20_000, env }
    )

    expect(output).toContain('SELF=[]')
    expect(output).toContain('CHILD_CLEAN')
    expect(output).not.toContain('history')
  })

  itWithZsh(
    'emits no OSC 133 and leaves a pane observably identical to an unwrapped one',
    async () => {
      // The deferred hook runs at the first prompt, so -c would inspect unfinished setup.
      const { env } = await launchHistoryOnly()
      const capture = [
        'PRECMD="${precmd_functions[*]}"; PREEXEC="${preexec_functions[*]}"',
        'LINEINIT="${widgets[zle-line-init]:-none}"'
      ]
      const report = ['PRECMD', 'PREEXEC', 'LINEINIT', 'ZDOTDIR', 'ORCA_SHELL_FEATURES']

      const wrapped = await runZshPty({ env, commands: capture, report })
      const unwrapped = await runZshPty({
        env: { PATH: '/usr/bin:/bin', HOME: home },
        commands: capture,
        report
      })

      expect(wrapped.output).not.toContain('\x1b]133;')
      expect(wrapped.values.PRECMD).toBe(unwrapped.values.PRECMD)
      expect(wrapped.values.PREEXEC).toBe(unwrapped.values.PREEXEC)
      // Global zsh config may install a widget; compare against the same host's unwrapped shell.
      expect(wrapped.values.LINEINIT).toBe(unwrapped.values.LINEINIT)
      expect(wrapped.values.PRECMD).not.toContain('orca')
      expect(wrapped.values.ZDOTDIR).toBe(unwrapped.values.ZDOTDIR)
      expect(wrapped.values.ORCA_SHELL_FEATURES).toBe('UNSET')
    }
  )
})
