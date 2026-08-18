/**
 * Real-zsh proof that a worktree-scoped HISTFILE survives shell startup.
 *
 * macOS `/etc/zshrc` assigns `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` with no
 * check-before-set, and it runs before every wrapper file Orca controls. So the
 * value `injectHistoryEnv` put in the spawn env is already gone by the time the
 * user reaches a prompt — and because ZDOTDIR still points at Orca's wrapper
 * dir, the replacement lands inside it. Per-worktree history was therefore a
 * silent no-op on the primary platform (#11044).
 *
 * Only a real zsh can show this: the string the wrapper emits looks correct
 * either way, and the whole bug lives in what /etc/zshrc does between the spawn
 * env and the first prompt.
 *
 * These tests drive the REAL launch decision (`selectShellStartupFeatures` +
 * `getShellLaunchConfig`) rather than an inline copy of the gate, so a pane that
 * Orca would not wrap cannot pass here by construction.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'

// Why probe and execute the same binary: guarding on `zsh` from PATH but then
// running a hardcoded `/bin/zsh` lets the guard pass on a host that installs zsh
// elsewhere, and the test fails for a missing binary rather than a wrapper
// defect. The absolute path is resolved once so the sandboxed PATH below cannot
// lose it.
const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const ZSH_PATH = hasZsh
  ? (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout || '').trim()
  : ''
const itWithZsh = hasZsh ? it : it.skip

function runZsh(
  args: string[],
  env: Record<string, string>,
  probe = 'echo "RESULT=$HISTFILE"'
): string {
  // -o noglobalrcs is deliberately NOT passed: /etc/zshrc is the thing under test.
  return execFileSync(ZSH_PATH, [...args, '-i', '-c', probe], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: '/usr/bin:/bin', ...env }
  })
}

/** Both streams, because a wrapper that breaks does it on stderr. */
function runZshCapturingStderr(args: string[], env: Record<string, string>, probe: string): string {
  const result = spawnSync(ZSH_PATH, [...args, '-i', '-c', probe], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH: '/usr/bin:/bin', ...env }
  })
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

/**
 * True when this host's system zshrc is the thing that destroys HISTFILE.
 *
 * Why probed and not keyed off `process.platform`: macOS ships the clobber in
 * /etc/zshrc, stock Ubuntu ships no such assignment, and a hardened corporate
 * image can go either way. Assertions that only mean something under a clobber
 * are skipped where there is none rather than asserting a tautology.
 */
const systemZshrcClobbersHistfile = (() => {
  if (!hasZsh) {
    return false
  }
  const home = mkdtempSync(join(tmpdir(), 'orca-histfile-probe-'))
  try {
    const output = execFileSync(ZSH_PATH, ['-l', '-i', '-c', 'echo "RESULT=$HISTFILE"'], {
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: home,
        HISTFILE: join(home, 'injected-history')
      }
    })
    return !output.includes(join(home, 'injected-history'))
  } catch {
    return false
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})()

const itWithClobber = systemZshrcClobbersHistfile ? itWithZsh : it.skip

/** The launch config Orca produces for a plain pane whose only Orca-owned
 *  concern is a worktree-scoped HISTFILE. */
function launchPlainHistoryPane(home: string, scopedHistfile: string) {
  const env: Record<string, string> = {
    HOME: home,
    HISTFILE: scopedHistfile,
    ORCA_HISTFILE: scopedHistfile
  }
  const features = selectShellStartupFeatures({
    shellPath: ZSH_PATH,
    env,
    hasStartupCommand: false,
    waitsForShellReady: false,
    emitsStartupIdentity: false
  })
  const launch = getShellLaunchConfig(ZSH_PATH, features)
  return {
    features,
    launch,
    env: { ...env, ...launch.env, ...sandboxConfigDir(home) }
  }
}

// Why override: the launch config resolves the user's config dir from the real
// process env, and these runs must resolve against the sandbox home instead.
function sandboxConfigDir(home: string): Record<string, string> {
  return { ORCA_ORIG_ZDOTDIR: home, ORCA_ZSHENV_SOURCE_DIR: home }
}

function withTempHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'orca-scoped-histfile-'))
  try {
    run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const histfileOf = (output: string): string =>
  /^RESULT=(.*)$/m.exec(output)?.[1]?.trim() ?? '<unmatched>'

describe('worktree-scoped HISTFILE survives zsh startup', () => {
  itWithZsh('wraps a plain pane once Orca injected a worktree HISTFILE', () => {
    withTempHome((home) => {
      const { features, launch } = launchPlainHistoryPane(home, join(home, 'zsh_history'))

      // The whole bug: this pane has no overlay env and no startup command, so
      // before this change nothing pointed it at a wrapper at all.
      expect(features).toEqual(['history'])
      expect(launch.env.ZDOTDIR).toBeTruthy()
      expect(launch.env.ORCA_SHELL_FEATURES).toBe('history')
    })
  })

  itWithClobber('keeps the injected path that the system zshrc would otherwise clobber', () => {
    withTempHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const { launch, env } = launchPlainHistoryPane(home, scoped)

      const output = runZsh(launch.args ?? ['-l'], env)

      expect(histfileOf(output)).toBe(scoped)
    })
  })

  itWithClobber('never leaves history inside Orca’s own wrapper directory', () => {
    withTempHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const { launch, env } = launchPlainHistoryPane(home, scoped)

      const output = runZsh(launch.args ?? ['-l'], env)

      // The exact failure mode of #11044: history written into shell-ready/zsh.
      expect(output).not.toContain(launch.env.ZDOTDIR)
    })
  })

  itWithClobber(
    'repairs the clobber for a shell that re-enters the wrapper with no features',
    () => {
      // Why: a non-interactive zsh runs .zshenv (which exports Orca's wrapper
      // ZDOTDIR) but never the epilogue that restores it, so an interactive zsh
      // started from there re-enters the wrapper with the feature channel already
      // consumed. /etc/zshrc still lands HISTFILE inside the wrapper dir — #11044
      // with no per-worktree scoping involved — so the repair cannot be gated on
      // a feature that no longer exists by then.
      withTempHome((home) => {
        const { launch } = launchPlainHistoryPane(home, join(home, 'orca-history', 'zsh_history'))

        const output = runZsh(launch.args ?? ['-l'], {
          HOME: home,
          ZDOTDIR: launch.env.ZDOTDIR,
          ORCA_ORIG_ZDOTDIR: home
        })

        expect(histfileOf(output)).toBe(join(home, '.zsh_history'))
      })
    }
  )

  itWithZsh('runs the epilogue for a login shell whose .zshrc ends in `emulate sh`', () => {
    // Why: zsh's sourcehome() ignores ZDOTDIR once the shell is in sh/ksh
    // emulation, so such a login shell reads $HOME/.zlogin instead of the
    // wrapper's. Everything the epilogue owns — the HISTFILE repair, the OSC 133
    // hooks, the readiness widget every startup command waits on — would be
    // skipped entirely.
    withTempHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const env: Record<string, string> = {
        HOME: home,
        HISTFILE: scoped,
        ORCA_HISTFILE: scoped
      }
      const launch = getShellLaunchConfig(
        ZSH_PATH,
        selectShellStartupFeatures({
          shellPath: ZSH_PATH,
          env,
          hasStartupCommand: true,
          waitsForShellReady: true,
          // Why off: the identity marker is printed with no trailing newline, so
          // it would prefix the first probe line and defeat the parser.
          emitsStartupIdentity: false
        })
      )
      writeFileSync(join(home, '.zshrc'), 'emulate sh\n')

      const output = runZsh(
        launch.args ?? ['-l'],
        { ...env, ...launch.env, ...sandboxConfigDir(home) },
        'echo "RESULT=$HISTFILE"; echo "WIDGET=[${widgets[zle-line-init]:-none}]"'
      )

      expect(histfileOf(output)).toBe(scoped)
      expect(output).toContain('WIDGET=[user:__orca_prompt_mark]')
    })
  })

  itWithZsh('consumes ORCA_HISTFILE so nothing the shell spawns can inherit it', () => {
    withTempHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const { launch, env } = launchPlainHistoryPane(home, scoped)

      const output = execFileSync(
        ZSH_PATH,
        [...(launch.args ?? ['-l']), '-i', '-c', 'echo "LEAK=[${ORCA_HISTFILE:-}]"'],
        {
          encoding: 'utf8',
          timeout: 20_000,
          env: { PATH: '/usr/bin:/bin', ...env }
        }
      )

      // Root-cause fix for #11146: the variable no longer exists after use.
      expect(output).toContain('LEAK=[]')
    })
  })

  itWithZsh('leaves HISTFILE exactly as an unwrapped zsh would when Orca injects nothing', () => {
    // Why compared against an unwrapped run rather than asserted non-empty: what
    // zsh defaults to is platform-specific. macOS `/etc/zshrc` assigns HISTFILE,
    // so it is always set there; a stock Ubuntu zsh has no such file and leaves
    // it EMPTY. The contract is that Orca's wrapper does not change it either
    // way, which is the same assertion on both.
    withTempHome((home) => {
      const features = selectShellStartupFeatures({
        shellPath: ZSH_PATH,
        env: { HOME: home, ORCA_CODEX_HOME: join(home, 'codex') },
        hasStartupCommand: false,
        waitsForShellReady: false,
        emitsStartupIdentity: false
      })
      const launch = getShellLaunchConfig(ZSH_PATH, features)
      const wrapped = runZsh(launch.args ?? ['-l'], {
        HOME: home,
        ORCA_CODEX_HOME: join(home, 'codex'),
        ...launch.env,
        ...sandboxConfigDir(home)
      })
      const unwrapped = runZsh(['-l'], { HOME: home })

      expect(histfileOf(wrapped)).toBe(histfileOf(unwrapped))
      expect(wrapped).not.toContain('ORCA_HISTFILE')
    })
  })
})

const PROBE =
  'echo "RESULT=$HISTFILE"; print -r -- "ZDOTDIR=[$ZDOTDIR]"; ' +
  'print -r -- "ORCA_HISTFILE=[${ORCA_HISTFILE:-unset}]"'

describe('the wrapper survives a hostile user zsh config', () => {
  // Why both forms: `REPLY` is zsh's shared scratch global, and the two ways a
  // user config constrains it fail differently. `typeset -r` makes the
  // wrapper's first assignment fatal and prints into the pane; `typeset -i`
  // turns every resolved path into 0 with no error text at all. Both aborted
  // the wrapper before the epilogue, leaving history inside Orca's own wrapper
  // dir — on 100% of zsh panes, not the few percent wrapped before.
  it.each(['typeset -r REPLY', 'typeset -i REPLY'])(
    'resolves the user config dir when the user .zshrc runs `%s`',
    (declaration) => {
      if (!hasZsh) {
        return
      }
      withTempHome((home) => {
        const scoped = join(home, 'orca-history', 'zsh_history')
        const { launch, env } = launchPlainHistoryPane(home, scoped)
        writeFileSync(join(home, '.zshrc'), `${declaration}\n`)

        const output = runZshCapturingStderr(launch.args ?? ['-l'], env, PROBE)

        expect(histfileOf(output)).toBe(scoped)
        expect(output).toContain(`ZDOTDIR=[${home}]`)
        expect(output).toContain('ORCA_HISTFILE=[unset]')
        expect(output).not.toContain('__orca_resolve_user_config_dir:')
      })
    }
  )

  // Why these two files and not .zshrc: zsh's sourcehome() ignores ZDOTDIR once
  // the shell is in sh/ksh emulation, so emulation entered from .zshenv or
  // .zprofile hides EVERY later wrapper file — the epilogue runs zero times and
  // can repair nothing. A .zshrc that does it is already covered by running the
  // epilogue from the wrapper .zshrc, which /etc/zshrc has run before.
  it.each([
    ['.zshenv', 'emulate sh'],
    ['.zshenv', 'emulate ksh'],
    ['.zprofile', 'emulate sh']
  ])('degrades to an unwrapped pane when the user %s runs `%s`', (file, statement) => {
    if (!hasZsh) {
      return
    }
    withTempHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const { launch, env } = launchPlainHistoryPane(home, scoped)
      writeFileSync(join(home, file), `${statement}\n`)

      const wrapped = runZshCapturingStderr(launch.args ?? ['-l'], env, PROBE)
      const unwrapped = runZsh(['-l'], { HOME: home, HISTFILE: scoped })

      // The bar: never worse off than the pane Orca did not wrap. What that is
      // differs per host (macOS /etc/zshrc clobbers HISTFILE, stock Ubuntu does
      // not), so it is read from an unwrapped run rather than hardcoded.
      expect(histfileOf(wrapped)).toBe(histfileOf(unwrapped))
      expect(histfileOf(wrapped)).not.toContain(launch.env.ZDOTDIR)
      expect(wrapped).toContain(`ZDOTDIR=[${home}]`)
      // Nothing this pane spawns may inherit a history path no wrapper file
      // will ever consume.
      expect(wrapped).toContain('ORCA_HISTFILE=[unset]')
    })
  })
})

/**
 * Records every argument-less `emulate` — i.e. exactly the wrapper's emulation
 * probe, and not the epilogue's `emulate -L zsh` — into a file the test reads.
 *
 * Why a shadowing function and not a timing assertion: the cost being removed
 * is a fork, and a fork is countable where milliseconds are flaky. Placed in
 * the user .zshenv so it is defined before all three probe sites.
 */
function probeCounterConfig(logPath: string): string {
  return [
    'emulate() {',
    `  (( $# == 0 )) && print -r -- probe >> ${JSON.stringify(logPath)}`,
    '  builtin emulate "$@"',
    '}'
  ].join('\n')
}

const probeCount = (logPath: string): number =>
  existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0

describe('the emulation probe forks only when it can change the answer', () => {
  itWithZsh('never forks for a pane whose config stays in zsh emulation', () => {
    withTempHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const log = join(home, 'probe.log')
      const { launch, env } = launchPlainHistoryPane(home, scoped)
      // All three probe sites are gated on having sourced the matching user
      // file, so every one of them has to exist for this to mean anything.
      writeFileSync(join(home, '.zshenv'), probeCounterConfig(log))
      writeFileSync(join(home, '.zprofile'), '')
      writeFileSync(join(home, '.zshrc'), '')

      const output = runZshCapturingStderr(launch.args ?? ['-l'], env, PROBE)

      expect(probeCount(log)).toBe(0)
      // The pane still has to work: the saving is a fork, not a feature.
      expect(histfileOf(output)).toBe(scoped)
      expect(output).toContain(`ZDOTDIR=[${home}]`)
    })
  })

  // Why kept exact rather than replaced by the option test: those options say
  // nothing about `emulation`, which is what zsh's sourcehome() branches on.
  itWithZsh('still forks to get the exact answer once a Bourne option is set', () => {
    withTempHome((home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const log = join(home, 'probe.log')
      const { launch, env } = launchPlainHistoryPane(home, scoped)
      writeFileSync(join(home, '.zshenv'), `${probeCounterConfig(log)}\nsetopt shwordsplit\n`)

      const output = runZshCapturingStderr(launch.args ?? ['-l'], env, PROBE)

      expect(probeCount(log)).toBeGreaterThan(0)
      // shwordsplit alone is not emulation, so the pane stays wrapped.
      expect(histfileOf(output)).toBe(scoped)
    })
  })
})
