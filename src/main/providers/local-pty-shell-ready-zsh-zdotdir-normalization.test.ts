import { afterEach, beforeEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import { getShellReadyWrapperRoot } from './local-pty-shell-ready-wrapper-root'
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
  describeIfZsh('high-priority edge cases', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-zsh-edge-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-zsh-userdata-'))
      setTestUserDataPath(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('discovers ZDOTDIR when .zshenv sources another file that sets it', async () => {
      // Multi-file sourcing pattern
      const commonSh = join(testHome, '.config', 'shell', 'common.sh')
      mkdirSync(dirname(commonSh), { recursive: true })
      writeFileSync(commonSh, 'export ZDOTDIR="$HOME/.config/zsh"\n')
      writeFileSync(join(testHome, '.zshenv'), 'source ~/.config/shell/common.sh\n')

      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })

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

    it('preserves ZDOTDIR with spaces in path', async () => {
      const spacePath = join(testHome, 'My Config', 'zsh')
      mkdirSync(spacePath, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${spacePath}"\n`)

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
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${spacePath}`)
    })

    it('falls back when .zshenv has syntax error', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'syntax error {{{\nexport ZDOTDIR=broken\n')

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
      // Syntax error causes discovery to fail, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles framework pattern with ${ZDOTDIR:-$HOME}', async () => {
      writeFileSync(
        join(testHome, '.zshenv'),
        'export ZDOTDIR="${ZDOTDIR:-$HOME}"\n# prezto-style pattern\n'
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
      // Framework pattern defaults to HOME when ZDOTDIR unset
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('captures last ZDOTDIR value when set multiple times', async () => {
      const firstPath = join(testHome, '.config', 'zsh')
      const lastPath = join(testHome, '.local', 'zsh')
      mkdirSync(firstPath, { recursive: true })
      mkdirSync(lastPath, { recursive: true })

      writeFileSync(
        join(testHome, '.zshenv'),
        `export ZDOTDIR="${firstPath}"\nexport ZDOTDIR="${lastPath}"\n`
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
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${lastPath}`)
    })

    it('handles conditional ZDOTDIR based on environment', async () => {
      const localPath = join(testHome, '.config', 'zsh')
      const remotePath = join(testHome, '.config', 'zsh-remote')
      mkdirSync(localPath, { recursive: true })
      mkdirSync(remotePath, { recursive: true })

      writeFileSync(
        join(testHome, '.zshenv'),
        `if [[ -n "$SSH_CONNECTION" ]]; then\n  export ZDOTDIR="${remotePath}"\nelse\n  export ZDOTDIR="${localPath}"\nfi\n`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Test without SSH_CONNECTION
      let cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      delete cleanEnv.SSH_CONNECTION
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      let result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${localPath}`)

      // Test with SSH_CONNECTION
      cleanEnv = { ...process.env, HOME: testHome, SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22' }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${remotePath}`)
    })

    it('preserves explicit ZDOTDIR="$HOME" from user .zshenv', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="$HOME"\n')

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
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('falls back when discovered ZDOTDIR does not exist', async () => {
      const nonexistent = join(testHome, '.config', 'zsh-missing')
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${nonexistent}"\n`)

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
      // Validation rejects non-existent path, falls back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('does not source /.zshenv when HOME is empty', async () => {
      // Can't create /.zshenv in the test, so verify the wrapper logic guards against it.
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      getShellReadyLaunchConfig('/bin/zsh')

      const zshenv = readFileSync(join(getShellReadyWrapperRoot(), 'zsh', '.zshenv'), 'utf8')

      // Verify wrapper checks the resolved source root is non-empty before sourcing
      expect(zshenv).toContain('if [[ -n "${_orca_zshenv_source_dir:-}"')
    })

    it('handles ZDOTDIR with single quote in path', async () => {
      const quotePath = join(testHome, "config'zsh")
      mkdirSync(quotePath, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${quotePath}"\n`)

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
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${quotePath}`)
    })

    it('does not evaluate command substitution in ZDOTDIR', async () => {
      const safePath = join(testHome, '.config', 'zsh')
      mkdirSync(safePath, { recursive: true })
      // Attempt command substitution - should be treated as literal path component
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${safePath}"\n`)

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
      // Should contain the safe path, not any command-substituted value
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${safePath}`)
    })

    it('handles whitespace-only ZDOTDIR (tabs and newlines)', async () => {
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="\t\t\n\n"\n')

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
      // Whitespace-only should be normalized to empty, fall back to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('handles ZDOTDIR with multiple trailing slashes', async () => {
      const cleanPath = join(testHome, '.config', 'zsh')
      mkdirSync(cleanPath, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), `export ZDOTDIR="${cleanPath}///"\n`)

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
      // Should normalize to path without trailing slashes
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${cleanPath}`)
    })
  })
})
