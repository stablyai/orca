/** Exercise real launch selection and a PTY prompt so system zshrc and deferred hooks can affect HISTFILE. */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import { hasZsh, makeZshHome, MARKERS, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip

/** Probe actual system config; platform alone cannot tell whether zshrc overwrites HISTFILE. */
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
    // Resolve config against the sandbox home instead of the real launch environment.
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

        expect(values.ORCA_HISTFILE).toBe('UNSET')
        expect(values.ORCA_SHELL_FEATURES).toBe('UNSET')
        expect(values.HISTFILE).toBe(scoped)
      })
    )

    itWithZsh(
      'leaves HISTFILE exactly as an unwrapped zsh would when Orca injects nothing',
      withHome(USER_FILES, async (home) => {
        // Defaults vary by host; compare with its unwrapped shell rather than a hardcoded HISTFILE.
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

        expect(values.CODEX_HOME).toBe('/orca/codex')
        expect(values.PATH.startsWith('/orca/shim:')).toBe(true)
      }
    )
  )
})

describe.skipIf(process.platform === 'win32')(
  'the wrapper survives a hostile user zsh config',
  () => {
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
      'still scopes history without leaking it when a config drops precmd_functions',
      withHome({ ...USER_FILES, '.zshrc': 'precmd_functions=()\n' }, async (home) => {
        const scoped = join(home, 'orca-history', 'zsh_history')
        const { env, launch } = launchPane(home, scoped)

        const report = ['HISTFILE', 'ORCA_HISTFILE', 'ZDOTDIR']
        const { values } = await runZshPty({ env, report })
        expect(values.HISTFILE).toBe(scoped)
        expect(values.HISTFILE).not.toContain(launch.env.ZDOTDIR)
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

          expect(values.ZDOTDIR).toBe(home)
          expect(values.ORCA_TEST_USER_ZSHRC).toBe('1')
        }
      )
    )
  }
)

/** Relay uses the same builder with different feature flags; exercise that variant in a real shell too. */

describe.skipIf(process.platform === 'win32')('the real-zsh harness', () => {
  itWithZsh(
    'waits for delayed first output before answering compinit and scoping history',
    withHome(
      {
        '.zshenv': 'sleep 0.6\nfpath=("$HOME/insecure-completions" $fpath)\n',
        '.zshrc':
          'if (( ! $+_comps )); then\n' +
          '  autoload -Uz compinit\n' +
          '  compinit -D\n' +
          'fi\n' +
          'export ORCA_TEST_COMPINIT_READY=$+_comps\n'
      },
      async (home) => {
        const completions = join(home, 'insecure-completions')
        mkdirSync(completions)
        chmodSync(completions, 0o777)
        writeFileSync(
          join(completions, '_orca_compinit_fixture'),
          '#compdef orca_compinit_fixture\n'
        )
        const scoped = join(home, 'scoped_history')
        const { env } = launchPane(home, scoped)

        const { output, values } = await runZshPty({
          env,
          report: ['HISTFILE', 'ORCA_TEST_COMPINIT_READY']
        })

        expect(output).toContain('Ignore insecure directories')
        expect(output).not.toContain('initialization aborted')
        expect(output).not.toContain('command not found: y')
        expect(values.ORCA_TEST_COMPINIT_READY).toBe('1')
        expect(values.HISTFILE).toBe(scoped)
      }
    )
  )
})
