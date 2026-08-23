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
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from './providers/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from './shell-templates'
import { hasZsh, makeZshHome, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip

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

/**
 * Regressions the four-file wrapper was built to fix, re-pinned against the one
 * that replaced it. Each names the change that introduced the behaviour, because
 * "the machinery is gone" is only a good answer if the reason it existed is gone
 * with it.
 */
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

  /**
   * Generates the tree, then points ZDOTDIR at it under a different root.
   *
   * Why the full spawn env and not a bare ZDOTDIR: "the user's .zshrc loaded" is
   * equally true of a pane that never read the wrapper at all, so the run has to
   * be able to show the wrapper ran. ORCA_SHELL_FEATURES coming back consumed is
   * that proof — only the wrapper's own .zshenv unsets it.
   */
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
      // Why relocation: on Windows+WSL the wrappers are generated with a Windows
      // path but sourced via /mnt/c, so the generation-time path is absent at
      // runtime. The old wrapper baked that path in as a ZDOTDIR fallback and had
      // to re-derive the real one from `%x` to avoid using it; this one bakes no
      // path, so the split cannot arise. Renaming the root reproduces it.
      const home = makeZshHome({ '.zshrc': 'export ORCA_TEST_FROM_ZSHRC=1\n' })
      try {
        const { values } = await runFromRelocatedRoot(home, `${userDataPath}-wsl-view`)

        expect(values.ORCA_TEST_FROM_ZSHRC).toBe('1')
        // The wrapper really was read from the relocated path.
        expect(values.ORCA_SHELL_FEATURES).toBe('UNSET')
        expect(values.HISTFILE).toBe(join(home, 'scoped_history'))
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )

  itWithZsh('loads the user .zshrc from a non-ASCII wrapper path (#8003)', async () => {
    // Why non-ASCII: a Korean Windows login puts UTF-8 bytes in zsh's 0x84-0x9D
    // token range, and zsh corrupts environment values containing them while
    // processing startup files. That corrupted the env-imported $ZDOTDIR, the
    // wrapper's self-check failed, and it fell back to the unusable baked path —
    // a bare prompt with none of the user's config. Nothing is baked now, and a
    // value this wrapper cannot use degrades to $HOME, where zsh itself looks.
    const home = makeZshHome({ '.zshrc': 'export ORCA_TEST_FROM_ZSHRC=1\n' })
    try {
      const { values } = await runFromRelocatedRoot(
        home,
        join(dirname(userDataPath), '홍길동-wsl-view')
      )

      expect(values.ORCA_TEST_FROM_ZSHRC).toBe('1')
      expect(values.ORCA_SHELL_FEATURES).toBe('UNSET')
      expect(values.HISTFILE).toBe(join(home, 'scoped_history'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itWithZsh('gives the user’s startup files their own ZDOTDIR while they run (#4667)', async () => {
    // Why it mattered: user startup files resolve plugin and theme paths from
    // $ZDOTDIR, so sourcing them with Orca's dir in place sent those lookups into
    // the wrapper. The old wrapper swapped ZDOTDIR around each source; this one
    // never takes it away, so each file sees what it would see unwrapped.
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
    // Why the shell checks this and not only Node: the launch config sets
    // ORCA_ORIG_ZDOTDIR when it resolved a usable dir, but a pane also inherits
    // its parent's environment, so a stale value written by an older build can
    // arrive on its own — a route the Node-side check never sees. Handing that
    // back would point ZDOTDIR at a wrapper dir, which is the self-loop the
    // ownership check exists to prevent. Identification stays positive: a stamped
    // marker file, or Orca's own path shape for wrappers older builds wrote.
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

      // Rejected, so zsh falls back to $HOME and the user's own config loads.
      expect(values.ZDOTDIR).toBe('UNSET')
      expect(values.ORCA_TEST_FROM_ZSHRC).toBe('1')
      expect(values.ORCA_TEST_FROM_WRAPPER_DIR).toBe('UNSET')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  itWithZsh('leaves a nested Orca nothing of its own to inherit (#11044, #11146)', async () => {
    // Why this closes #11044's plain shape rather than repairing it: that bug was
    // a nested zsh inheriting Orca's ZDOTDIR, so /etc/zshrc derived HISTFILE
    // inside the wrapper dir. A pane can no longer hand any child a ZDOTDIR that
    // is Orca's, because it does not have one itself past the first few lines.
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

      // Neither channel survives into a child, and no ZDOTDIR of Orca's does.
      // `UNSET` here is the probe's rendering of an empty capture, i.e. `env`
      // printed no ZDOTDIR line at all.
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
