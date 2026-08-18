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
  describeIfZsh('automation and edge cases', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-auto-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-auto-userdata-'))
      setTestUserDataPath(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('matches normal zsh when user .zshenv calls exit', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\nexit 42\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "survived"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(42)
      expect(result.stdout).not.toContain('survived')
    })

    it('survives user .zshenv with set -e and failing command', async () => {
      writeFileSync(
        join(testHome, '.zshenv'),
        'set -e\nfalse\nexport ZDOTDIR="$HOME/.config/zsh"\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // No ZDOTDIR was reached after the failing command, so we fall back.
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('survives user .zshenv with set -u before ZDOTDIR is set', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), 'set -u\nexport ZDOTDIR="$HOME/.config/zsh"\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Should work because wrapper uses ${ZDOTDIR:-} which is safe with set -u
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('survives user .zshenv with nullglob set', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        'setopt nullglob\nexport ZDOTDIR="$HOME/.config/zsh"\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
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

    it('survives user .zshenv with extendedglob set', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        'setopt extendedglob\nexport ZDOTDIR="$HOME/.config/zsh"\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
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

    it('preserves exported .zshenv environment changes in the wrapper shell', async () => {
      writeFileSync(
        join(testHome, '.zshenv'),
        'export MY_VAR=from-zshenv\nexport ZDOTDIR="$HOME/.config/zsh"\n'
      )

      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      delete cleanEnv.MY_VAR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "MY_VAR=${MY_VAR:-unset}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('MY_VAR=from-zshenv')
    })

    it('handles empty HOME gracefully', async () => {
      // When HOME is empty, wrapper should not attempt to source /.zshenv
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { HOME: '' }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Empty HOME falls back to empty ORCA_ORIG_ZDOTDIR
      expect(result.stdout).toContain('ORCA_ORIG_ZDOTDIR=\n')
    })

    it('handles unset HOME gracefully', async () => {
      // Why: zsh initializes HOME from /etc/passwd when unset at spawn, so the wrapper can still discover ZDOTDIR.
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = {}
      delete cleanEnv.HOME
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // zsh initializes HOME from passwd, wrapper discovers ZDOTDIR normally
      expect(result.stdout).toMatch(/ORCA_ORIG_ZDOTDIR=.+/)
    })

    it('handles ZDOTDIR containing only "/"', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="/"\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Single slash normalizes to empty after %/, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles ZDOTDIR containing only slashes "///"', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="///"\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Multiple slashes normalize to "/" then to empty after %/, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles user .zshenv that unsets HOME', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `unset HOME\nexport ZDOTDIR="${xdgZshDir}"\n`)

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Subshell unsets HOME but wrapper HOME is in parent scope
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })

    it('handles user .zshenv that sets ZDOTDIR to empty string', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR=""\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // Empty string should be normalized away, fall back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles conditional unset of ZDOTDIR', async () => {
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        `export ZDOTDIR="${xdgZshDir}"\nif [[ "\${TERM}" == "dumb" ]]; then\n  unset ZDOTDIR\nfi\n`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Test with TERM=dumb
      let cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        TERM: 'dumb'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      let result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // ZDOTDIR unset conditionally, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)

      // Test with TERM=xterm
      cleanEnv = { ...process.env, HOME: testHome, TERM: 'xterm-256color' }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      // ZDOTDIR not unset, uses discovered value
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
    })
  })
})
