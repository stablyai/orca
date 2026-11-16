/** Exercise real launch selection and a PTY prompt so system zshrc and deferred hooks can affect HISTFILE. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getShellLaunchConfig } from '../../providers/local-pty/local-pty-shell-ready'
import { selectShellStartupFeatures } from './shell-startup-features'
import { hasZsh, makeZshHome, runZshPty, ZSH_PATH } from './zsh-startup-hook-pty-harness'

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
    itWithClobber(
      'keeps the injected path that the system zshrc would otherwise clobber',
      withHome(USER_FILES, async (home) => {
        const scoped = join(home, 'orca-history', 'zsh_history')
        const { env } = launchPane(home, scoped)

        const { values } = await runZshPty({ env, report: ['HISTFILE'] })

        expect(values.HISTFILE).toBe(scoped)
      })
    )
  }
)
