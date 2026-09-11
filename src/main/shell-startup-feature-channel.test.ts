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
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from './pty/posix-shell-startup-command'
import { selectShellStartupFeatures } from './shell-startup-features'
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

  it('wraps a startup-only command without enabling shell readiness', async () => {
    const { getShellLaunchConfig } = await importFreshLocalPtyShellReady()

    const config = getShellLaunchConfig('/bin/zsh', [], 'codex')

    expect(config.env.ORCA_SHELL_FEATURES).toBe('startup')
    expect(config.env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe('codex')
    expect(config.supportsReadyMarker).toBe(false)
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

      // Empty dir: not a config root whoever wrote it. Absent rather than $HOME
      // because the wrapper hands this value straight back to the shell, and a
      // user with no ZDOTDIR must end up with none.
      expect(getShellLaunchConfig('/bin/zsh', ['history']).env.ORCA_ORIG_ZDOTDIR).toBeUndefined()

      // Stamped as Orca-owned: rejected by positive identification, even though
      // the path shape is not one of Orca's.
      writeFileSync(join(foreignWrapper, '.zshrc'), '')
      writeFileSync(join(foreignWrapper, ZSH_WRAPPER_DIR_MARKER_FILE), '')
      const stamped = await importFreshLocalPtyShellReady()
      expect(
        stamped.getShellLaunchConfig('/bin/zsh', ['history']).env.ORCA_ORIG_ZDOTDIR
      ).toBeUndefined()

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

      // Why a PTY: every feature is delivered from a precmd hook, and a shell
      // started with -c never reaches a prompt to run one.
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
        // Why ORCA_ORIG_ZDOTDIR is stripped: the launch config computes it from
        // the real process env, which would leak the developer's own ZDOTDIR
        // into the run. This sandbox home has none, so the pane must end up with
        // none — which is also what makes it comparable to an unwrapped pane.
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
    // A grandchild that saw the variable would have printed its value first.
    expect(output).not.toContain('history')
  })

  itWithZsh(
    'emits no OSC 133 and leaves a pane observably identical to an unwrapped one',
    async () => {
      // Why a PTY: the hook runs from the first prompt's precmd sweep, so a shell
      // started with -c would report a pane Orca had not finished setting up.
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
      // The whole point of removing the hook rather than parking a no-op in its
      // place: a history-only pane leaves no Orca name in the user's hook arrays.
      expect(wrapped.values.PRECMD).toBe(unwrapped.values.PRECMD)
      expect(wrapped.values.PREEXEC).toBe(unwrapped.values.PREEXEC)
      // Why compared and not pinned to 'none': a host whose global zsh config
      // installs its own zle-line-init widget has one either way, and what Orca
      // owes is that it looks the same wrapped as unwrapped.
      expect(wrapped.values.LINEINIT).toBe(unwrapped.values.LINEINIT)
      expect(wrapped.values.PRECMD).not.toContain('orca')
      // ZDOTDIR matches too, because the wrapper hands back exactly what it found.
      expect(wrapped.values.ZDOTDIR).toBe(unwrapped.values.ZDOTDIR)
      expect(wrapped.values.ORCA_SHELL_FEATURES).toBe('UNSET')
    }
  )
})
