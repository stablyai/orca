/**
 * Real-zsh proof that a worktree-scoped HISTFILE survives shell startup, and
 * that the rest of Orca's startup features arrive with it.
 *
 * macOS `/etc/zshrc` assigns `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` with no
 * check-before-set. Orca used to fight that by keeping its own ZDOTDIR in place
 * across `/etc/zshrc` and repairing the damage afterwards (#11044). It now hands
 * ZDOTDIR back before that file runs, so the value `/etc/zshrc` derives is the
 * user's own path and the scoped one is re-applied from the deferred hook.
 *
 * Only a real zsh on a real PTY can show any of this: the wrapper text looks
 * correct either way, the whole question is what `/etc/zshrc` does between the
 * spawn env and the first prompt, and the hook is a `precmd` — which a shell
 * started with `-c` never reaches.
 *
 * These tests drive the REAL launch decision (`selectShellStartupFeatures` +
 * `getShellLaunchConfig`) rather than an inline copy of the gate, so a pane that
 * Orca would not wrap cannot pass here by construction.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureOverlayRestoreWrappers } from '../relay/pty-shell-overlay-wrappers'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import { hasZsh, makeZshHome, MARKERS, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip

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
      env: { PATH: '/usr/bin:/bin', HOME: home, HISTFILE: join(home, 'injected-history') }
    })
    return !output.includes(join(home, 'injected-history'))
  } catch {
    return false
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})()

const itWithClobber = systemZshrcClobbersHistfile ? itWithZsh : it.skip

/** The launch config Orca produces for a pane with exactly these features. */
function launchPane(
  home: string,
  scopedHistfile: string | null,
  overrides: Partial<Parameters<typeof selectShellStartupFeatures>[0]> = {}
) {
  const env: Record<string, string> = {
    HOME: home,
    ...(scopedHistfile ? { HISTFILE: scopedHistfile, ORCA_HISTFILE: scopedHistfile } : {})
  }
  const features = selectShellStartupFeatures({
    shellPath: ZSH_PATH,
    env,
    hasStartupCommand: false,
    waitsForShellReady: false,
    emitsStartupIdentity: false,
    ...overrides
  })
  const launch = getShellLaunchConfig(ZSH_PATH, features)
  return {
    features,
    launch,
    // Why ORCA_ORIG_ZDOTDIR overridden: the launch config resolves the user's
    // config dir from the real process env, and these runs must resolve against
    // the sandbox home instead.
    env: { PATH: '/usr/bin:/bin', ...env, ...launch.env, ORCA_ORIG_ZDOTDIR: home }
  }
}

const USER_FILES = {
  '.zshenv': 'export ORCA_TEST_USER_ZSHENV=1\n',
  '.zprofile': 'export ORCA_TEST_USER_ZPROFILE=1\n',
  '.zshrc': 'export ORCA_TEST_USER_ZSHRC=1\n'
}

function withHome(files: Record<string, string>, run: (home: string) => Promise<void>) {
  return async () => {
    const home = makeZshHome(files)
    try {
      await run(home)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

describe.skipIf(process.platform === 'win32')(
  'worktree-scoped HISTFILE survives zsh startup',
  () => {
    itWithZsh(
      'wraps a plain pane once Orca injected a worktree HISTFILE',
      withHome(USER_FILES, async (home) => {
        const { features, launch } = launchPane(home, join(home, 'zsh_history'))

        // The whole reason wrapping widened: this pane has no overlay env and no
        // startup command, so before #15258 nothing pointed it at a wrapper.
        expect(features).toEqual(['history'])
        expect(launch.env.ZDOTDIR).toBeTruthy()
        expect(launch.env.ORCA_SHELL_FEATURES).toBe('history')
      })
    )

    itWithClobber(
      'keeps the injected path that the system zshrc would otherwise clobber',
      withHome(USER_FILES, async (home) => {
        const scoped = join(home, 'orca-history', 'zsh_history')
        const { env } = launchPane(home, scoped)

        const { values } = await runZshPty({ env, report: ['HISTFILE'] })

        expect(values.HISTFILE).toBe(scoped)
      })
    )

    itWithZsh(
      'hands ZDOTDIR back before the user’s own startup files load',
      withHome(USER_FILES, async (home) => {
        const { env, launch } = launchPane(home, join(home, 'orca-history', 'zsh_history'))

        const { values } = await runZshPty({
          env,
          report: [
            'ZDOTDIR',
            'ORCA_TEST_USER_ZSHENV',
            'ORCA_TEST_USER_ZPROFILE',
            'ORCA_TEST_USER_ZSHRC'
          ]
        })

        // Each user file is read from the user's own dir, exactly as unwrapped.
        expect(values.ORCA_TEST_USER_ZSHENV).toBe('1')
        expect(values.ORCA_TEST_USER_ZPROFILE).toBe('1')
        expect(values.ORCA_TEST_USER_ZSHRC).toBe('1')
        expect(values.ZDOTDIR).toBe(home)
        expect(values.ZDOTDIR).not.toBe(launch.env.ZDOTDIR)
      })
    )

    itWithZsh(
      'never leaves history inside Orca’s own wrapper directory',
      withHome(USER_FILES, async (home) => {
        const { env, launch } = launchPane(home, join(home, 'orca-history', 'zsh_history'))

        const { values } = await runZshPty({ env, report: ['HISTFILE'] })

        // #11044's exact failure mode. It is now unreachable rather than repaired:
        // /etc/zshrc derives HISTFILE from a ZDOTDIR that is already the user's.
        expect(values.HISTFILE).not.toContain(launch.env.ZDOTDIR)
      })
    )

    itWithZsh(
      'consumes ORCA_HISTFILE so nothing the shell spawns can inherit it',
      withHome(USER_FILES, async (home) => {
        const scoped = join(home, 'orca-history', 'zsh_history')
        const { env } = launchPane(home, scoped)

        const { values } = await runZshPty({
          env,
          report: ['ORCA_HISTFILE', 'ORCA_SHELL_FEATURES', 'HISTFILE']
        })

        // Root-cause fix for #11146: the variables no longer exist after use.
        expect(values.ORCA_HISTFILE).toBe('UNSET')
        expect(values.ORCA_SHELL_FEATURES).toBe('UNSET')
        expect(values.HISTFILE).toBe(scoped)
      })
    )

    itWithZsh(
      'leaves HISTFILE exactly as an unwrapped zsh would when Orca injects nothing',
      withHome(USER_FILES, async (home) => {
        // Why compared against an unwrapped run rather than asserted non-empty:
        // what zsh defaults to is platform-specific. macOS /etc/zshrc assigns
        // HISTFILE, so it is always set there; a stock Ubuntu zsh leaves it EMPTY.
        // The contract is that Orca's wrapper does not change it either way.
        const overlayEnv = { ORCA_CODEX_HOME: join(home, 'codex') }
        const features = selectShellStartupFeatures({
          shellPath: ZSH_PATH,
          env: { HOME: home, ...overlayEnv },
          hasStartupCommand: false,
          waitsForShellReady: false,
          emitsStartupIdentity: false
        })
        const launch = getShellLaunchConfig(ZSH_PATH, features)

        const wrapped = await runZshPty({
          env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            ...overlayEnv,
            ...launch.env,
            ORCA_ORIG_ZDOTDIR: home
          },
          report: ['HISTFILE']
        })
        const unwrapped = await runZshPty({
          env: { PATH: '/usr/bin:/bin', HOME: home },
          report: ['HISTFILE']
        })

        expect(wrapped.values.HISTFILE).toBe(unwrapped.values.HISTFILE)
      })
    )
  }
)

describe.skipIf(process.platform === 'win32')('the deferred hook delivers every feature', () => {
  itWithZsh(
    'emits the identity, readiness and OSC 133 markers a startup command waits on',
    withHome(USER_FILES, async (home) => {
      const scoped = join(home, 'orca-history', 'zsh_history')
      const { env, features } = launchPane(home, scoped, {
        hasStartupCommand: true,
        waitsForShellReady: true,
        emitsStartupIdentity: true
      })
      expect(features).toEqual(expect.arrayContaining(['markers', 'ready', 'identity']))

      const { output, values } = await runZshPty({
        env,
        commands: ['true'],
        report: ['HISTFILE']
      })

      expect(output).toMatch(MARKERS.identity)
      expect(output).toContain(MARKERS.ready)
      expect(output).toContain(MARKERS.promptStart)
      expect(output).toContain(MARKERS.commandStart)
      expect(output).toMatch(MARKERS.commandDone)
      expect(values.HISTFILE).toBe(scoped)
    })
  )

  itWithZsh(
    'restores Orca’s overlay values after the user’s config overwrites them',
    withHome(
      {
        ...USER_FILES,
        '.zshrc': 'export CODEX_HOME=/user/codex\nexport PATH=/user/bin:$PATH\n'
      },
      async (home) => {
        const overlayEnv = {
          ORCA_CODEX_HOME: '/orca/codex',
          ORCA_AGENT_TEAMS_SHIM_DIR: '/orca/shim'
        }
        const features = selectShellStartupFeatures({
          shellPath: ZSH_PATH,
          env: { HOME: home, ...overlayEnv },
          hasStartupCommand: false,
          waitsForShellReady: false,
          emitsStartupIdentity: false
        })
        const launch = getShellLaunchConfig(ZSH_PATH, features)

        const { values } = await runZshPty({
          env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            ...overlayEnv,
            ...launch.env,
            ORCA_ORIG_ZDOTDIR: home
          },
          report: ['CODEX_HOME', 'PATH']
        })

        // The point of running last: the user's .zshrc set both of these after
        // the spawn env did, and Orca's values still win.
        expect(values.CODEX_HOME).toBe('/orca/codex')
        expect(values.PATH.startsWith('/orca/shim:')).toBe(true)
      }
    )
  )
})

describe.skipIf(process.platform === 'win32')(
  'the wrapper survives a hostile user zsh config',
  () => {
    /**
     * Why these three cases and not the old degrade matrix: zsh's `sourcehome()`
     * ignores ZDOTDIR once the shell is in sh/ksh emulation, which used to hide
     * every wrapper file after the one that entered it — so emulation from
     * `.zshenv` or `.zprofile` cost the pane all of Orca's features. Only one
     * wrapper file is read now, and it is read before any user file can change
     * modes, so these are wins rather than degradations.
     */
    it.each([
      ['.zshenv', 'emulate sh'],
      ['.zshenv', 'emulate ksh'],
      ['.zprofile', 'emulate sh'],
      ['.zshrc', 'emulate sh'],
      ['.zshrc', 'setopt no_unset'],
      ['.zshrc', 'setopt ksharrays']
    ])('still scopes history when the user %s runs `%s`', async (file, statement) => {
      if (!hasZsh) {
        return
      }
      const home = makeZshHome({
        ...USER_FILES,
        [file]: `${USER_FILES[file as keyof typeof USER_FILES]}${statement}\n`
      })
      try {
        const scoped = join(home, 'orca-history', 'zsh_history')
        const { env } = launchPane(home, scoped)

        const { values } = await runZshPty({ env, report: ['HISTFILE', 'ORCA_HISTFILE'] })

        expect(values.HISTFILE).toBe(scoped)
        expect(values.ORCA_HISTFILE).toBe('UNSET')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })

    itWithZsh(
      'degrades to an unwrapped pane, leaking nothing, when a config drops precmd_functions',
      withHome({ ...USER_FILES, '.zshrc': 'precmd_functions=()\n' }, async (home) => {
        const scoped = join(home, 'orca-history', 'zsh_history')
        const { env, launch } = launchPane(home, scoped)

        const report = ['HISTFILE', 'ORCA_HISTFILE', 'ZDOTDIR']
        const { values } = await runZshPty({ env, report })
        // Why compared against an unwrapped run rather than asserted to differ
        // from the scoped path: whether the scoped value survives at all is the
        // host's call, not Orca's. macOS /etc/zshrc overwrites HISTFILE, so it
        // does not; a host with no such assignment keeps whatever the spawn env
        // set. The contract on both is the same — this pane is the pane the user
        // would have had unwrapped.
        const unwrapped = await runZshPty({
          env: { PATH: '/usr/bin:/bin', HOME: home, HISTFILE: scoped },
          report
        })

        expect(values.HISTFILE).toBe(unwrapped.values.HISTFILE)
        expect(values.HISTFILE).not.toContain(launch.env.ZDOTDIR)
        // ORCA_HISTFILE was consumed in .zshenv precisely so a dropped hook
        // leaks nothing to the pane's children.
        expect(values.ORCA_HISTFILE).toBe('UNSET')
        expect(values.ZDOTDIR).toBe(home)
      })
    )

    itWithZsh(
      'loads the user config even when a startup file writes an unrelated ZDOTDIR',
      withHome(
        { ...USER_FILES, '.zshenv': `${USER_FILES['.zshenv']}export ZDOTDIR="$HOME"\n` },
        async (home) => {
          const { env } = launchPane(home, join(home, 'orca-history', 'zsh_history'))

          const { values } = await runZshPty({
            env,
            report: ['ZDOTDIR', 'ORCA_TEST_USER_ZSHRC']
          })

          // A ZDOTDIR the user's own .zshenv exports is theirs by construction and
          // needs no discovery machinery: zsh reads .zshrc through it directly.
          expect(values.ZDOTDIR).toBe(home)
          expect(values.ORCA_TEST_USER_ZSHRC).toBe('1')
        }
      )
    )
  }
)

/**
 * The relay writes its own variant of the hook: no OSC 133 (its bash rcfile owns
 * those on remote hosts) and a remote CLI bin dir on PATH instead of the
 * agent-teams shim. It used to have a whole second ZDOTDIR shape too, which is
 * why it drifted from the desktop template; now the only differences are the
 * spec flags, and this pins that the variant still works in a real shell.
 */
describe.skipIf(process.platform === 'win32')('the relay variant of the hook', () => {
  itWithZsh(
    'scopes history and restores the remote CLI path without emitting OSC 133',
    withHome(USER_FILES, async (home) => {
      const relayRoot = mkdtempSync(join(tmpdir(), 'orca-relay-wrapper-'))
      try {
        expect(ensureOverlayRestoreWrappers(relayRoot)).toBe(true)
        const scoped = join(home, 'orca-history', 'zsh_history')

        const { output, values } = await runZshPty({
          env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            ZDOTDIR: join(relayRoot, 'zsh'),
            ORCA_ORIG_ZDOTDIR: home,
            ORCA_SHELL_FEATURES: 'overlay,history,ready',
            ORCA_HISTFILE: scoped,
            ORCA_REMOTE_CLI_BIN_DIR: '/orca/remote-bin'
          },
          commands: ['true'],
          report: ['HISTFILE', 'ZDOTDIR', 'PATH', 'ORCA_HISTFILE']
        })

        expect(values.HISTFILE).toBe(scoped)
        expect(values.ZDOTDIR).toBe(home)
        expect(values.ORCA_HISTFILE).toBe('UNSET')
        expect(values.PATH.startsWith('/orca/remote-bin:')).toBe(true)
        expect(output).toContain(MARKERS.ready)
        // Remote panes get their command lifecycle from the bash rcfile, so the
        // zsh variant must stay silent here.
        expect(output).not.toContain(MARKERS.promptStart)
        expect(output).not.toContain(MARKERS.commandStart)
      } finally {
        rmSync(relayRoot, { recursive: true, force: true })
      }
    })
  )
})
