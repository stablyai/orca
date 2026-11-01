import { afterEach, beforeEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  describeIfZsh,
  describePosix,
  importFreshLocalPtyShellReady,
  restoreUserDataPathAfterEach,
  setTestUserDataPath
} from './local-pty-shell-ready-test-harness'

restoreUserDataPathAfterEach()

describePosix('live zsh subprocess tests', () => {
  describeIfZsh('terminal emulator edge cases', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-term-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-term-userdata-'))
      setTestUserDataPath(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('prioritizes fresh discovery over inherited ORCA_ORIG_ZDOTDIR', async () => {
      const freshZdotdir = join(testHome, '.config', 'zsh-updated')
      mkdirSync(freshZdotdir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${freshZdotdir}"\n`)

      const previousOrcaZdotdir = process.env.ORCA_ORIG_ZDOTDIR
      const oldZdotdir = join(testHome, '.config', 'zsh-old')
      process.env.ORCA_ORIG_ZDOTDIR = oldZdotdir

      try {
        const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
        const config = getShellReadyLaunchConfig('/bin/zsh')

        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          HOME: testHome,
          ORCA_ORIG_ZDOTDIR: oldZdotdir
        }
        delete cleanEnv.ZDOTDIR
        cleanEnv.ZDOTDIR = config.env.ZDOTDIR

        const result = spawnSync('zsh', ['-c', 'echo "ZDOTDIR=${ZDOTDIR}"'], {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        })

        expect(result.status).toBe(0)
        expect(result.stdout).toContain(`ZDOTDIR=${freshZdotdir}`)
      } finally {
        if (previousOrcaZdotdir === undefined) {
          delete process.env.ORCA_ORIG_ZDOTDIR
        } else {
          process.env.ORCA_ORIG_ZDOTDIR = previousOrcaZdotdir
        }
      }
    })

    it('sources launch-time ZDOTDIR .zshenv when it is explicitly inherited', async () => {
      const homeZdotdir = join(testHome, '.config', 'zsh-home')
      const inheritedZdotdir = join(testHome, '.config', 'zsh-inherited')
      mkdirSync(homeZdotdir, { recursive: true })
      mkdirSync(inheritedZdotdir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        `export SOURCE_MARKER=home\nexport ZDOTDIR="${homeZdotdir}"\n`
      )
      writeFileSync(
        join(inheritedZdotdir, '.zshenv'),
        `export SOURCE_MARKER=inherited\nexport ZDOTDIR="${inheritedZdotdir}"\n`
      )

      const previousZdotdir = process.env.ZDOTDIR
      const previousHome = process.env.HOME
      process.env.ZDOTDIR = inheritedZdotdir
      process.env.HOME = testHome

      try {
        const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
        const config = getShellReadyLaunchConfig('/bin/zsh')
        // The wrapper restores this one user directory before zsh reads .zshenv.
        expect(config.env.ORCA_ORIG_ZDOTDIR).toBe(inheritedZdotdir)

        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          ...config.env,
          HOME: testHome
        }

        const result = spawnSync(
          'zsh',
          ['-c', 'echo "ZDOTDIR=${ZDOTDIR}" && echo "SOURCE_MARKER=${SOURCE_MARKER:-unset}"'],
          {
            env: cleanEnv as NodeJS.ProcessEnv,
            encoding: 'utf8'
          }
        )

        expect(result.status).toBe(0)
        expect(result.stdout).toContain(`ZDOTDIR=${inheritedZdotdir}`)
        expect(result.stdout).toContain('SOURCE_MARKER=inherited')
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
      }
    })
  })
})
