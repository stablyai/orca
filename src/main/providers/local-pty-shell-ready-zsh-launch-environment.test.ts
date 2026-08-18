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

// End-to-end validation that wrapper ZDOTDIR discovery preserves top-level zsh semantics (spawns real zsh; gated on availability).
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

    it('discovers ZDOTDIR when launched inside tmux', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${xdgZshDir}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        TMUX: '/tmp/tmux-501/default,12345,0',
        TMUX_PANE: '%0'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('discovers ZDOTDIR when launched from SSH session', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${xdgZshDir}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22',
        SSH_CLIENT: '10.0.0.1 12345 22',
        LC_CTYPE: 'C.UTF-8'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('handles sudo -E where HOME and ZDOTDIR mismatch', async () => {
      // Why a real dir: an inherited ZDOTDIR only counts as the user's config
      // root when it actually holds a zsh startup file.
      const userZdotdir = join(testHome, '.config', 'zsh')
      mkdirSync(userZdotdir, { recursive: true })
      writeFileSync(join(userZdotdir, '.zshrc'), '')

      const previousZdotdir = process.env.ZDOTDIR
      const previousHome = process.env.HOME
      process.env.ZDOTDIR = userZdotdir
      process.env.HOME = '/root' // sudo changed HOME

      try {
        const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
        const config = getShellReadyLaunchConfig('/bin/zsh')

        // Should preserve user's ZDOTDIR from spawn env, not fall back to /root
        expect(config.env.ORCA_ORIG_ZDOTDIR).toBe(userZdotdir)
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

    it('re-discovers ZDOTDIR despite stale ORCA_ORIG_ZDOTDIR from previous session', async () => {
      const currentZdotdir = join(testHome, '.config', 'zsh-current')
      mkdirSync(currentZdotdir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${currentZdotdir}"\n`)

      const previousOrcaZdotdir = process.env.ORCA_ORIG_ZDOTDIR
      process.env.ORCA_ORIG_ZDOTDIR = '/opt/orca-old/shell-ready/zsh' // stale wrapper path

      try {
        const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
        const config = getShellReadyLaunchConfig('/bin/zsh')

        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          HOME: testHome,
          ORCA_ORIG_ZDOTDIR: '/opt/orca-old/shell-ready/zsh'
        }
        delete cleanEnv.ZDOTDIR
        cleanEnv.ZDOTDIR = config.env.ZDOTDIR

        const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        })

        expect(result.status).toBe(0)
        // Should discover fresh value from .zshenv, not use stale wrapper path
        expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${currentZdotdir}`)
      } finally {
        if (previousOrcaZdotdir === undefined) {
          delete process.env.ORCA_ORIG_ZDOTDIR
        } else {
          process.env.ORCA_ORIG_ZDOTDIR = previousOrcaZdotdir
        }
      }
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

        const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        })

        expect(result.status).toBe(0)
        // Should use fresh discovery (user updated .zshenv)
        expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${freshZdotdir}`)
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
        expect(config.env.ORCA_ZSHENV_SOURCE_DIR).toBe(inheritedZdotdir)

        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          ...config.env,
          HOME: testHome
        }

        const result = spawnSync(
          'zsh',
          [
            '-c',
            'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}" && echo "SOURCE_MARKER=${SOURCE_MARKER:-unset}"'
          ],
          {
            env: cleanEnv as NodeJS.ProcessEnv,
            encoding: 'utf8'
          }
        )

        expect(result.status).toBe(0)
        expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${inheritedZdotdir}`)
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
