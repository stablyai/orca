/**
 * The feature channel's two load-bearing guarantees:
 *
 * 1. Leak-proof — the selection is a pure function of spawn env + launch intent,
 *    and the variable that carries it is destroyed by the wrapper before the
 *    user's own config runs. Neither an inherited value nor a stale one in
 *    `process.env` can turn a feature on or off for a shell or its children.
 *    (#15197 shipped exported switches twice and re-broke #11146 and agent
 *    status both times.)
 * 2. Behaviour parity — a pane wrapped only because Orca injected a worktree
 *    HISTFILE runs exactly what an unwrapped pane runs, with no OSC 133.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { selectShellStartupFeatures } from './shell-startup-features'
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
    // Why: the value a parent shell exported is not an input. If it were, a pane
    // opened from another pane would inherit that pane's feature set.
    expect(
      selectShellStartupFeatures({
        shellPath: '/bin/zsh',
        env: { ORCA_SHELL_FEATURES: 'overlay,markers,ready,identity,history' },
        ...PLAIN_PANE
      })
    ).toEqual([])
  })

  it('cannot be turned off for a pane that needs a feature', () => {
    // Why: the allowlist is positive only — there is no value of the variable
    // that suppresses anything, so an inherited one can never mean "less".
    expect(
      selectShellStartupFeatures({
        shellPath: '/bin/zsh',
        env: { ORCA_SHELL_FEATURES: '', ORCA_HISTFILE: '/tmp/wt/zsh_history' },
        ...PLAIN_PANE
      })
    ).toEqual(['history'])
  })

  it('gives a history-only pane no command markers', () => {
    // Why: markers would be new output on a pane that emitted none before.
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
    // Why: bash has no system rc that clobbers HISTFILE, and `--rcfile` would
    // replace its login startup-file chain with Orca's approximation.
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

  it('publishes exactly the selected features, whatever process.env holds', async () => {
    process.env.ORCA_SHELL_FEATURES = 'overlay,markers,ready,identity'
    const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getShellLaunchConfig('/bin/zsh', ['history'])

    expect(config.env.ORCA_SHELL_FEATURES).toBe('history')
  })

  it('falls back to plain login zsh when the wrapper tree cannot be written', async () => {
    // Why: pointing ZDOTDIR at an unwritten wrapper dir makes zsh skip the
    // user's entire configuration — silently, and for every future pane.
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
    // Why: Orca can be launched from a terminal that already owns ZDOTDIR. Only
    // a dir Orca can prove is its own, or one holding no zsh startup file at
    // all, may be rejected — never a vendor guessed at by name.
    const home = mkdtempSync(join(tmpdir(), 'orca-stacked-zdotdir-'))
    const foreignWrapper = join(home, 'other-terminal', 'zsh')
    mkdirSync(foreignWrapper, { recursive: true })
    const previousZdotdir = process.env.ZDOTDIR
    const previousHome = process.env.HOME
    process.env.ZDOTDIR = foreignWrapper
    process.env.HOME = home
    try {
      const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()

      // Empty dir: not a config root whoever wrote it.
      expect(getShellLaunchConfig('/bin/zsh', ['history']).env.ORCA_ORIG_ZDOTDIR).toBe(home)

      // Stamped as Orca-owned: rejected by positive identification, even though
      // the path shape is not one of Orca's.
      writeFileSync(join(foreignWrapper, '.zshrc'), '')
      writeFileSync(join(foreignWrapper, ZSH_WRAPPER_DIR_MARKER_FILE), '')
      const stamped = await importFreshLocalPtyShellReady()
      expect(stamped.getShellLaunchConfig('/bin/zsh', ['history']).env.ORCA_ORIG_ZDOTDIR).toBe(home)

      // A real user config dir still round-trips.
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

  // Why these two: the epilogue is one function that runs after the user's own
  // config, so an option that config left set applies to all of it. NO_UNSET
  // made the prompt-hook append a fatal error that returned from the epilogue
  // before the ready widget and the ZDOTDIR restore; KSH_ARRAYS made the
  // 1-based feature subscript miss whichever feature is listed first.
  it.each(['no_unset', 'ksh_arrays'])(
    'still runs every feature when the user set %s',
    async (option) => {
      if (!hasZsh) {
        return
      }
      const scoped = join(home, 'orca-history', 'zsh_history')
      const opencodeDir = join(home, 'opencode-overlay')
      writeFileSync(join(home, '.zshrc'), `setopt ${option}\n`)
      // Why an overlay pane: KSH_ARRAYS only drops whichever feature is listed
      // first, and `overlay` is the first token the selector ever emits.
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

      const output = execFileSync(
        ZSH_PATH,
        [
          ...(launch.args ?? ['-l']),
          '-i',
          '-c',
          'print -r -- "LINEINIT=${widgets[zle-line-init]:-none}"; ' +
            'print -r -- "PRECMD=${precmd_functions[*]:-none}"; ' +
            'print -r -- "OPENCODE=${OPENCODE_CONFIG_DIR:-none}"; ' +
            'print -r -- "ZDOTDIR=${ZDOTDIR:-}"; print -r -- "HISTFILE=${HISTFILE:-}"'
        ],
        {
          encoding: 'utf8',
          timeout: 20_000,
          env: {
            PATH: '/usr/bin:/bin',
            ...spawnEnv,
            ...launch.env,
            ORCA_ORIG_ZDOTDIR: home,
            ORCA_ZSHENV_SOURCE_DIR: home
          }
        }
      )

      expect(output).toContain('LINEINIT=user:__orca_prompt_mark')
      expect(output).toContain('PRECMD=__orca_osc133_precmd')
      expect(output).toContain(`OPENCODE=${opencodeDir}`)
      expect(output).toContain(`ZDOTDIR=${home}`)
      expect(output).toContain(`HISTFILE=${scoped}`)
    }
  )
})

/** A temp HOME whose four zsh startup files each announce that they ran. */
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

  const OBSERVABLES =
    'print -r -- "PRECMD=${precmd_functions[*]}"; ' +
    'print -r -- "PREEXEC=${preexec_functions[*]}"; ' +
    'print -r -- "LINEINIT=${widgets[zle-line-init]:-none}"; ' +
    'print -r -- "ZDOTDIR=$ZDOTDIR"; ' +
    'print -r -- "FEATURES=[${ORCA_SHELL_FEATURES:-}]"; ' +
    'print -r -- "ORCA_HISTFILE=[${ORCA_HISTFILE:-}]"'

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
        ...launch.env,
        // Why override: the launch config reads the real process env, and this
        // run must resolve the user's config against the sandbox home.
        ORCA_ORIG_ZDOTDIR: home,
        ORCA_ZSHENV_SOURCE_DIR: home
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
    // A grandchild that saw the variable would have printed its value first.
    expect(output).not.toContain('history')
  })

  itWithZsh('emits no OSC 133 and matches an unwrapped pane', async () => {
    const { args, env } = await launchHistoryOnly()

    const wrapped = execFileSync(ZSH_PATH, [...args, '-i', '-c', OBSERVABLES], {
      encoding: 'utf8',
      timeout: 20_000,
      env
    })
    const unwrapped = execFileSync(ZSH_PATH, ['-l', '-i', '-c', OBSERVABLES], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: '/usr/bin:/bin', HOME: home }
    })

    expect(wrapped).not.toContain('\x1b]133;')
    expect(wrapped).toContain('PRECMD=\n')
    expect(wrapped).toContain('LINEINIT=none')
    // Startup files run in the same order with the same hooks, so the pane is
    // observably what it was before it got wrapped.
    const comparable = (output: string): string[] =>
      output
        .split('\n')
        .filter((line) => !line.startsWith('ORCA_HISTFILE=') && !line.startsWith('ZDOTDIR='))
    expect(comparable(wrapped)).toEqual(comparable(unwrapped))
    // The one carried-over difference, unchanged from every pane Orca already
    // wrapped: ZDOTDIR ends up explicitly set to the user's config dir, which
    // is the value zsh itself defaults to when it is unset.
    expect(wrapped).toContain(`ZDOTDIR=${home}`)
    expect(unwrapped).toContain('ZDOTDIR=\n')
  })
})
