/** Compare wrapped and unwrapped PTYs against the host's own config resolution, including unusual .zshenv files. */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from './shell-templates'
import { hasZsh, makeZshHome, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip

const REPORTED = ['ZDOTDIR', 'ORCA_TEST_MARK', 'ORCA_TEST_FROM_ZSHRC', 'PATH'] as const

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
      // A top-level-only path declaration proves .zshenv was not sourced inside a function or subshell.
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
  // Remove the real inherited config directory so these cases resolve only from the sandbox HOME.
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

describe.skipIf(process.platform === 'win32')('the fixes the old wrapper was built for', () => {
  let userDataPath = ''
  let previousUserDataPath: string | undefined

  beforeAll(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-hook-regression-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterAll(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
  })

  /** Use full launch env so consumed feature state proves the relocated wrapper actually ran. */
  async function runFromRelocatedRoot(home: string, movedRoot: string) {
    const env = wrappedEnv(home)
    const relocated = env.ZDOTDIR.replace(userDataPath, movedRoot)
    expect(relocated, 'the relocated ZDOTDIR should differ from the generated one').not.toBe(
      env.ZDOTDIR
    )
    renameSync(userDataPath, movedRoot)
    try {
      return await runZshPty({
        env: { ...env, ZDOTDIR: relocated },
        report: ['ORCA_TEST_FROM_ZSHRC', 'ORCA_SHELL_FEATURES', 'HISTFILE']
      })
    } finally {
      if (existsSync(movedRoot)) {
        renameSync(movedRoot, userDataPath)
      }
    }
  }

  itWithZsh(
    'loads the user .zshrc when the wrapper is sourced from a relocated path (#8003)',
    async () => {
      // Relocate to model Windows-generated wrappers sourced through a different WSL /mnt path.
      const home = makeZshHome({ '.zshrc': 'export ORCA_TEST_FROM_ZSHRC=1\n' })
      try {
        const { values } = await runFromRelocatedRoot(home, `${userDataPath}-wsl-view`)

        expect(values.ORCA_TEST_FROM_ZSHRC).toBe('1')
        expect(values.ORCA_SHELL_FEATURES).toBe('UNSET')
        expect(values.HISTFILE).toBe(join(home, 'scoped_history'))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  itWithZsh('loads the user .zshrc from a non-ASCII wrapper path (#8003)', async () => {
    // Korean UTF-8 bytes overlap zsh's token range and can corrupt env-imported ZDOTDIR during startup.
    const home = makeZshHome({ '.zshrc': 'export ORCA_TEST_FROM_ZSHRC=1\n' })
    try {
      // A unique destination avoids collisions with directories left by killed test runs.
      const { values } = await runFromRelocatedRoot(
        home,
        join(dirname(userDataPath), `홍길동-${basename(userDataPath)}`)
      )

      expect(values.ORCA_TEST_FROM_ZSHRC).toBe('1')
      expect(values.ORCA_SHELL_FEATURES).toBe('UNSET')
      expect(values.HISTFILE).toBe(join(home, 'scoped_history'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itWithZsh('gives the user’s startup files their own ZDOTDIR while they run (#4667)', async () => {
    const home = makeZshHome({})
    const xdg = join(home, '.config', 'zsh')
    mkdirSync(xdg, { recursive: true })
    writeFileSync(join(home, '.zshenv'), `export ZDOTDIR=${JSON.stringify(xdg)}\n`)
    writeFileSync(join(xdg, '.zshrc'), 'export ORCA_TEST_IN_ZSHRC="$ZDOTDIR"\n')
    writeFileSync(join(xdg, '.zprofile'), 'export ORCA_TEST_IN_ZPROFILE="$ZDOTDIR"\n')
    try {
      const report = ['ORCA_TEST_IN_ZSHRC', 'ORCA_TEST_IN_ZPROFILE']
      const wrapped = await runZshPty({ env: wrappedEnv(home), report })
      const unwrapped = await runZshPty({ env: { PATH: '/usr/bin:/bin', HOME: home }, report })

      expect(wrapped.values.ORCA_TEST_IN_ZSHRC).toBe(xdg)
      expect(wrapped.values.ORCA_TEST_IN_ZPROFILE).toBe(xdg)
      expect(wrapped.values).toEqual(unwrapped.values)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itWithZsh('refuses an inherited ZDOTDIR that is an Orca wrapper dir (#15258)', async () => {
    // Older parents can supply stale ORCA_ORIG_ZDOTDIR without passing through Node's ownership check.
    const home = makeZshHome({ '.zshrc': 'export ORCA_TEST_FROM_ZSHRC=1\n' })
    const foreign = join(home, 'other-terminal', 'zsh')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, '.zshrc'), 'export ORCA_TEST_FROM_WRAPPER_DIR=1\n')
    writeFileSync(join(foreign, ZSH_WRAPPER_DIR_MARKER_FILE), '')
    try {
      const { values } = await runZshPty({
        env: { ...wrappedEnv(home), ORCA_ORIG_ZDOTDIR: foreign },
        report: ['ZDOTDIR', 'ORCA_TEST_FROM_ZSHRC', 'ORCA_TEST_FROM_WRAPPER_DIR']
      })

      expect(values.ZDOTDIR).toBe('UNSET')
      expect(values.ORCA_TEST_FROM_ZSHRC).toBe('1')
      expect(values.ORCA_TEST_FROM_WRAPPER_DIR).toBe('UNSET')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itWithZsh('leaves a nested Orca nothing of its own to inherit (#11044, #11146)', async () => {
    const home = makeZshHome({ '.zshrc': 'export ORCA_TEST_FROM_ZSHRC=1\n' })
    try {
      const { values } = await runZshPty({
        env: wrappedEnv(home),
        commands: [
          'ORCA_CHILD_ENV="$(env | grep -cE \'^(ORCA_SHELL_FEATURES|ORCA_HISTFILE)=\' || true)"',
          'ORCA_CHILD_ZDOTDIR="$(env | sed -n \'s/^ZDOTDIR=//p\')"'
        ],
        report: ['ORCA_CHILD_ENV', 'ORCA_CHILD_ZDOTDIR']
      })

      expect(values.ORCA_CHILD_ENV).toBe('0')
      expect(values.ORCA_CHILD_ZDOTDIR).toBe('UNSET')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itWithZsh('survives a user .zshenv that returns early (#1947)', async () => {
    const home = makeZshHome({
      '.zshenv': 'export ORCA_TEST_MARK=early\nreturn 0\nexport ORCA_TEST_MARK=late\n',
      '.zshrc': 'export ORCA_TEST_FROM_ZSHRC=1\n'
    })
    try {
      const report = ['ORCA_TEST_MARK', 'ORCA_TEST_FROM_ZSHRC', 'ZDOTDIR']
      const wrapped = await runZshPty({ env: wrappedEnv(home), report })
      const unwrapped = await runZshPty({ env: { PATH: '/usr/bin:/bin', HOME: home }, report })

      expect(wrapped.values).toEqual(unwrapped.values)
      expect(wrapped.values.ORCA_TEST_FROM_ZSHRC).toBe('1')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
