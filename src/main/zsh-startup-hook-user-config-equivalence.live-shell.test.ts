/**
 * Real-zsh proof that a wrapped pane resolves the user's zsh config to exactly
 * what an unwrapped pane would, for every odd or hostile `.zshenv` shape.
 *
 * These cases were previously asserted one expected value at a time against
 * `ORCA_ORIG_ZDOTDIR` — the output of Orca's own shell-side ZDOTDIR discovery.
 * That discovery is gone: the wrapper hands ZDOTDIR back on its first lines and
 * zsh resolves the rest natively, so there is no Orca-computed value left to
 * assert on. The contract those tests were really protecting is the one below,
 * and stated as an equivalence it is stricter — it pins the wrapped pane to
 * whatever the host's own zsh does, including on hosts where that differs,
 * rather than to a value hardcoded here.
 *
 * Each case runs twice on a real PTY, once wrapped and once not, and the two
 * must agree on where the config came from and what it exported.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import { hasZsh, makeZshHome, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

/** What both arms must agree on: where config came from, and what it exported. */
const REPORTED = ['ZDOTDIR', 'ORCA_TEST_MARK', 'ORCA_TEST_FROM_ZSHRC', 'PATH'] as const

/**
 * Every case writes `$HOME/.zshenv`. `.zshrc` is written into whichever dir the
 * case points ZDOTDIR at, so "did the right .zshrc load" is observable.
 */
type ConfigCase = {
  name: string
  /** Builds `$HOME/.zshenv` and any extra files. Returns the dir holding .zshrc. */
  setup: (home: string) => string
}

const CASES: ConfigCase[] = [
  {
    name: 'no ZDOTDIR at all',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'export ORCA_TEST_MARK=plain\n')
      return home
    }
  },
  {
    name: 'ZDOTDIR exported to an XDG dir',
    setup: (home) => {
      const dir = join(home, '.config', 'zsh')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(home, '.zshenv'), `export ORCA_TEST_MARK=xdg\nexport ZDOTDIR="${dir}"\n`)
      return dir
    }
  },
  {
    name: 'ZDOTDIR set by a file the .zshenv sources',
    setup: (home) => {
      const dir = join(home, '.config', 'zsh')
      mkdirSync(dir, { recursive: true })
      const common = join(home, '.config', 'shell', 'common.sh')
      mkdirSync(dirname(common), { recursive: true })
      writeFileSync(common, `export ZDOTDIR="${dir}"\n`)
      writeFileSync(join(home, '.zshenv'), `export ORCA_TEST_MARK=sourced\nsource "${common}"\n`)
      return dir
    }
  },
  {
    name: 'ZDOTDIR with spaces in the path',
    setup: (home) => {
      const dir = join(home, 'My Config', 'zsh')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(home, '.zshenv'),
        `export ORCA_TEST_MARK=spaces\nexport ZDOTDIR="${dir}"\n`
      )
      return dir
    }
  },
  {
    name: 'ZDOTDIR set more than once',
    setup: (home) => {
      const first = join(home, 'first')
      const dir = join(home, 'second')
      mkdirSync(first, { recursive: true })
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(home, '.zshenv'),
        `export ORCA_TEST_MARK=twice\nexport ZDOTDIR="${first}"\nexport ZDOTDIR="${dir}"\n`
      )
      return dir
    }
  },
  {
    name: 'ZDOTDIR written with a trailing slash',
    setup: (home) => {
      const dir = join(home, 'trailing')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(home, '.zshenv'),
        `export ORCA_TEST_MARK=trailing\nexport ZDOTDIR="${dir}/"\n`
      )
      return dir
    }
  },
  {
    name: 'ZDOTDIR pointing at a directory that does not exist',
    setup: (home) => {
      writeFileSync(
        join(home, '.zshenv'),
        `export ORCA_TEST_MARK=missing\nexport ZDOTDIR="${join(home, 'nope')}"\n`
      )
      return home
    }
  },
  {
    name: 'ZDOTDIR set to the empty string',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'export ORCA_TEST_MARK=empty\nexport ZDOTDIR=""\n')
      return home
    }
  },
  {
    name: 'ZDOTDIR explicitly set to $HOME',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'export ORCA_TEST_MARK=home\nexport ZDOTDIR="$HOME"\n')
      return home
    }
  },
  {
    name: 'a .zshenv with a syntax error',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'export ORCA_TEST_MARK=broken\nif [ ; then\n')
      return home
    }
  },
  {
    name: 'a .zshenv running set -u before anything else',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'set -u\nexport ORCA_TEST_MARK=nounset\n')
      return home
    }
  },
  {
    name: 'a .zshenv running set -e with a failing command',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'set -e\nexport ORCA_TEST_MARK=errexit\nfalse\n')
      return home
    }
  },
  {
    name: 'a .zshenv setting extendedglob and nullglob',
    setup: (home) => {
      writeFileSync(
        join(home, '.zshenv'),
        'setopt extendedglob nullglob\nexport ORCA_TEST_MARK=globs\n'
      )
      return home
    }
  },
  {
    name: 'a .zshenv that unsets HOME',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'export ORCA_TEST_MARK=nohome\nunset HOME\n')
      return home
    }
  },
  {
    name: 'ZDOTDIR containing only slashes',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'export ORCA_TEST_MARK=slashes\nexport ZDOTDIR="///"\n')
      return home
    }
  },
  {
    name: 'a whitespace-only ZDOTDIR',
    setup: (home) => {
      writeFileSync(
        join(home, '.zshenv'),
        'export ORCA_TEST_MARK=blank\nexport ZDOTDIR="$(printf \'\\t\\n\')"\n'
      )
      return home
    }
  },
  {
    name: 'ZDOTDIR with a single quote in the path',
    setup: (home) => {
      const dir = join(home, "it's zsh")
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(home, '.zshenv'),
        `export ORCA_TEST_MARK=quote\nexport ZDOTDIR=${JSON.stringify(dir)}\n`
      )
      return dir
    }
  },
  {
    name: 'a .zshenv that conditionally unsets ZDOTDIR',
    setup: (home) => {
      writeFileSync(
        join(home, '.zshenv'),
        'export ORCA_TEST_MARK=conditional\nexport ZDOTDIR="$HOME/x"\nunset ZDOTDIR\n'
      )
      return home
    }
  },
  {
    name: 'a .zshenv using typeset -U path at top level',
    setup: (home) => {
      // Why this one matters: `path` is a top-level-only construct, so it also
      // proves the user's .zshenv is sourced in the wrapper's own scope rather
      // than inside a function or subshell.
      writeFileSync(
        join(home, '.zshenv'),
        'typeset -U path\npath=(/usr/bin /bin /usr/bin)\nexport ORCA_TEST_MARK=uniqpath\n'
      )
      return home
    }
  },
  {
    name: 'a .zshenv defining a function and extending fpath',
    setup: (home) => {
      const fns = join(home, 'fns')
      mkdirSync(fns, { recursive: true })
      writeFileSync(
        join(home, '.zshenv'),
        `fpath=(${JSON.stringify(fns)} $fpath)\norca_test_fn() { : }\nexport ORCA_TEST_MARK=fnscope\n`
      )
      return home
    }
  },
  {
    name: 'a .zshenv that calls exit',
    setup: (home) => {
      writeFileSync(join(home, '.zshenv'), 'export ORCA_TEST_MARK=exiting\nexit 0\n')
      return home
    }
  }
]

function wrappedEnv(home: string): Record<string, string> {
  const features = selectShellStartupFeatures({
    shellPath: ZSH_PATH,
    env: { HOME: home, ORCA_HISTFILE: join(home, 'scoped_history') },
    hasStartupCommand: false,
    waitsForShellReady: false,
    emitsStartupIdentity: false
  })
  const launch = getShellLaunchConfig(ZSH_PATH, features)
  // Why ORCA_ORIG_ZDOTDIR is dropped rather than pinned to the sandbox home:
  // these cases are about a user who has no inherited ZDOTDIR, so the pane must
  // resolve purely from HOME — and Orca must not invent a ZDOTDIR for it. The
  // launch config computes this one from the real process env, which would
  // otherwise leak the developer's own ZDOTDIR into the run.
  const { ORCA_ORIG_ZDOTDIR: _dropped, ...env } = launch.env
  return {
    PATH: '/usr/bin:/bin',
    HOME: home,
    ORCA_HISTFILE: join(home, 'scoped_history'),
    ...env
  }
}

describe.skipIf(process.platform === 'win32')(
  'a wrapped pane resolves the user config exactly as an unwrapped one does',
  () => {
    it.each(CASES.map((testCase) => [testCase.name, testCase] as const))(
      'matches unwrapped zsh for %s',
      async (_name, testCase) => {
        if (!hasZsh) {
          return
        }
        const home = makeZshHome({})
        try {
          const zshrcDir = testCase.setup(home)
          mkdirSync(zshrcDir, { recursive: true })
          writeFileSync(join(zshrcDir, '.zshrc'), 'export ORCA_TEST_FROM_ZSHRC=1\n')

          const wrapped = await runZshPty({ env: wrappedEnv(home), report: REPORTED })
          const unwrapped = await runZshPty({
            env: { PATH: '/usr/bin:/bin', HOME: home },
            report: REPORTED
          })

          expect(wrapped.exitedBeforePrompt).toBe(unwrapped.exitedBeforePrompt)
          for (const key of REPORTED) {
            expect(
              wrapped.values[key],
              `${key} differs between a wrapped and an unwrapped pane`
            ).toBe(unwrapped.values[key])
          }
        } finally {
          rmSync(home, { recursive: true, force: true })
        }
      }
    )
  }
)
