/** Compare wrapped and unwrapped PTYs against the host's own config resolution, including unusual .zshenv files. */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from '../../providers/local-pty/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import { ZSH_WRAPPER_DIR_MARKER_FILE } from './shell-templates'
import { hasZsh, makeZshHome, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip

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
})
