import { afterEach, beforeEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import {
  describeIfZsh,
  describePosix,
  importFreshLocalPtyShellReady,
  restoreUserDataPathAfterEach,
  setTestUserDataPath
} from './local-pty-shell-ready-test-harness'
// Why resolved rather than hardcoded: the wrapper tree is content-addressed.
import { getShellReadyWrapperRoot } from './local-pty-shell-ready-wrapper-root'

restoreUserDataPathAfterEach()

// End-to-end validation that wrapper ZDOTDIR discovery preserves top-level zsh semantics (spawns real zsh; gated on availability).
describePosix('live zsh subprocess tests', () => {
  describeIfZsh('ZDOTDIR discovery with real zsh', () => {
    let testHome: string
    let userDataPath: string

    beforeEach(async () => {
      testHome = mkdtempSync(join(tmpdir(), 'orca-zsh-test-home-'))
      userDataPath = mkdtempSync(join(tmpdir(), 'orca-zsh-test-userdata-'))
      setTestUserDataPath(userDataPath)
    })

    afterEach(() => {
      rmSync(testHome, { recursive: true, force: true })
      rmSync(userDataPath, { recursive: true, force: true })
    })

    it('preserves typeset -U path scoping when user .zshrc uses it', async () => {
      // Why: PR #1737's function-wrapper made "typeset -U path" function-scoped; user rcfiles must source at top level.

      // Create XDG-style config: .zshenv sets ZDOTDIR, .zshrc modifies PATH
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        `export ZDOTDIR="$HOME/.config/zsh"
`
      )
      writeFileSync(
        join(xdgZshDir, '.zshrc'),
        `typeset -U path
path=(/custom/bin $path)
`
      )

      // Generate the Orca wrapper
      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Verify the wrapper discovered XDG ZDOTDIR, sourced user .zshrc, and kept typeset -U path (proves top-level scoping).
      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        PATH: '/usr/bin:/bin'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR // Point to Orca wrapper dir

      const result = spawnSync(
        'zsh',
        [
          '-i',
          '-c',
          'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}" && echo "PATH_HAS_CUSTOM=${PATH%%:*}"'
        ],
        {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        }
      )

      expect(result.status).toBe(0)
      const output = result.stdout
      expect(output).toContain(`ORCA_ORIG_ZDOTDIR=${xdgZshDir}`)
      expect(output).toContain('PATH_HAS_CUSTOM=/custom/bin')
    })

    it('loads user .zshrc when wrappers are sourced from a different runtime path (WSL simulation)', async () => {
      // Why: issue #8003 — WSL sources Windows-generated wrappers via /mnt/c where the baked path is absent; renaming userData reproduces that split.
      writeFileSync(join(testHome, '.zshrc'), 'export USER_ZSHRC_LOADED=yes\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      getShellReadyLaunchConfig('/bin/zsh')

      const movedUserData = `${userDataPath}-wsl-view`
      renameSync(userDataPath, movedUserData)
      try {
        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          HOME: testHome,
          PATH: '/usr/bin:/bin'
        }
        delete cleanEnv.ZDOTDIR
        delete cleanEnv.ORCA_ORIG_ZDOTDIR
        delete cleanEnv.USER_ZSHRC_LOADED
        // Why the prefix swap: the tree is content-addressed under the user data
        // dir, so the relocated ZDOTDIR has to follow the resolved root.
        cleanEnv.ZDOTDIR = join(
          getShellReadyWrapperRoot().replace(userDataPath, movedUserData),
          'zsh'
        )

        // Cover both the WSL login shell (`exec zsh -l`) and the non-login local-pane flow so both restore paths stay pinned.
        for (const args of [['-i'], ['-l', '-i']] as const) {
          const result = spawnSync(
            'zsh',
            [
              ...args,
              '-c',
              'echo "USER_ZSHRC_LOADED=${USER_ZSHRC_LOADED:-no}" && echo "FINAL_ZDOTDIR=${ZDOTDIR:-unset}" && echo "IS_LOGIN=$([[ -o login ]] && echo yes || echo no)"'
            ],
            {
              env: cleanEnv as NodeJS.ProcessEnv,
              encoding: 'utf8'
            }
          )

          expect(result.status, `zsh ${args.join(' ')} failed: ${result.stderr}`).toBe(0)
          expect(result.stdout).toContain('USER_ZSHRC_LOADED=yes')
          expect(result.stdout).toContain(`FINAL_ZDOTDIR=${testHome}`)
          // Why: `as const` makes .includes('-l') reject the tuple union type; check by position instead.
          expect(result.stdout).toContain(args[0] === '-l' ? 'IS_LOGIN=yes' : 'IS_LOGIN=no')
        }
      } finally {
        rmSync(movedUserData, { recursive: true, force: true })
      }
    })

    it('loads user .zshrc when the wrapper dir contains a non-ASCII (token-range) path', async () => {
      // Why: issue #8003 — non-ASCII usernames put UTF-8 bytes in zsh's 0x84-0x9D token range, corrupting env-imported $ZDOTDIR; derive from %x instead.
      writeFileSync(join(testHome, '.zshrc'), 'export USER_ZSHRC_LOADED=yes\n')

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      getShellReadyLaunchConfig('/bin/zsh')

      // Move wrappers under a non-ASCII root so the baked literal is unusable and runtime $ZDOTDIR corrupts on import.
      const nonAsciiUserData = join(dirname(userDataPath), '홍길동-wsl-view')
      renameSync(userDataPath, nonAsciiUserData)
      try {
        const cleanEnv: Record<string, string | undefined> = {
          ...process.env,
          HOME: testHome,
          PATH: '/usr/bin:/bin'
        }
        delete cleanEnv.ZDOTDIR
        delete cleanEnv.ORCA_ORIG_ZDOTDIR
        delete cleanEnv.USER_ZSHRC_LOADED
        // Why the prefix swap: the tree is content-addressed under the user data
        // dir, so the relocated ZDOTDIR has to follow the resolved root.
        cleanEnv.ZDOTDIR = join(
          getShellReadyWrapperRoot().replace(userDataPath, nonAsciiUserData),
          'zsh'
        )

        for (const args of [['-i'], ['-l', '-i']] as const) {
          const result = spawnSync(
            'zsh',
            [...args, '-c', 'echo "USER_ZSHRC_LOADED=${USER_ZSHRC_LOADED:-no}"'],
            {
              env: cleanEnv as NodeJS.ProcessEnv,
              encoding: 'utf8'
            }
          )

          expect(result.status, `zsh ${args.join(' ')} failed: ${result.stderr}`).toBe(0)
          expect(result.stdout).toContain('USER_ZSHRC_LOADED=yes')
        }
      } finally {
        rmSync(nonAsciiUserData, { recursive: true, force: true })
      }
    })

    it('preserves top-level .zshenv path and function side effects', async () => {
      // Why: .zshenv is the normal place for always-on env/path setup; dropping side effects regresses zsh startup.
      const xdgZshDir = join(testHome, '.config', 'zsh')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(
        join(testHome, '.zshenv'),
        `typeset -U path
path=(/env/bin $path)
export MY_VAR=from-zshenv
orca_zshenv_func() { echo "from-zshenv-function"; }
export ZDOTDIR="$HOME/.config/zsh"
`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = {
        ...process.env,
        HOME: testHome,
        PATH: '/usr/bin:/bin'
      }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      delete cleanEnv.MY_VAR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync(
        'zsh',
        [
          '-c',
          'echo "PATH_HEAD=${PATH%%:*}" && echo "MY_VAR=${MY_VAR:-unset}" && orca_zshenv_func'
        ],
        {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        }
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('PATH_HEAD=/env/bin')
      expect(result.stdout).toContain('MY_VAR=from-zshenv')
      expect(result.stdout).toContain('from-zshenv-function')
    })

    it('sources user startup files with their own ZDOTDIR in scope', async () => {
      // Why: plugin managers such as Antidote resolve files from $ZDOTDIR while startup files are sourced.
      const xdgZshDir = join(testHome, '.config', 'zsh')
      const zdotdirLog = join(testHome, 'zdotdir.log')
      mkdirSync(xdgZshDir, { recursive: true })
      writeFileSync(join(testHome, '.zshenv'), 'export ZDOTDIR="$HOME/.config/zsh"\n')
      writeFileSync(
        join(xdgZshDir, '.zprofile'),
        'printf "zprofile=%s\\n" "$ZDOTDIR" >> "$HOME/zdotdir.log"\n'
      )
      writeFileSync(
        join(xdgZshDir, '.zshrc'),
        'printf "zshrc=%s\\n" "$ZDOTDIR" >> "$HOME/zdotdir.log"\n'
      )
      writeFileSync(
        join(xdgZshDir, '.zlogin'),
        'printf "zlogin=%s\\n" "$ZDOTDIR" >> "$HOME/zdotdir.log"\n'
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR

      const result = spawnSync(
        'zsh',
        ['-l', '-i', '-c', 'printf "command=%s\\n" "$ZDOTDIR" >> "$HOME/zdotdir.log"'],
        {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8',
          timeout: 5000
        }
      )

      expect(result.status).toBe(0)
      expect(readFileSync(zdotdirLog, 'utf8')).toBe(
        [
          `zprofile=${xdgZshDir}`,
          `zshrc=${xdgZshDir}`,
          `zlogin=${xdgZshDir}`,
          `command=${xdgZshDir}`,
          ''
        ].join('\n')
      )
    })

    it('survives early return in user .zshenv without crashing', async () => {
      // Why: early return is a common non-interactive-skip pattern; top-level sourcing must keep the wrapper running.
      writeFileSync(
        join(testHome, '.zshenv'),
        `[[ -o interactive ]] || return 0
export ZDOTDIR="$HOME/.config/zsh"
`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Build clean env: use wrapper ZDOTDIR but let wrapper discover ORCA_ORIG_ZDOTDIR at runtime
      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR // Point to Orca wrapper dir

      const result = spawnSync(
        'zsh',
        ['-c', 'echo "survived" && echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'],
        {
          env: cleanEnv as NodeJS.ProcessEnv,
          encoding: 'utf8'
        }
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('survived')
      // ZDOTDIR discovery yields nothing (early return before export), fallback to HOME
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })

    it('falls back to HOME when user .zshenv does not set ZDOTDIR', async () => {
      // Why: vanilla zsh users don't set ZDOTDIR, so the fallback chain must land on HOME.
      writeFileSync(
        join(testHome, '.zshenv'),
        `# Vanilla zsh config, no ZDOTDIR
export MY_VAR=foo
`
      )

      const { getShellReadyLaunchConfig } = await importFreshLocalPtyShellReady()
      const config = getShellReadyLaunchConfig('/bin/zsh')

      // Build clean env: use wrapper ZDOTDIR but let wrapper discover ORCA_ORIG_ZDOTDIR at runtime
      const cleanEnv: Record<string, string | undefined> = { ...process.env, HOME: testHome }
      delete cleanEnv.ZDOTDIR
      delete cleanEnv.ORCA_ORIG_ZDOTDIR
      cleanEnv.ZDOTDIR = config.env.ZDOTDIR // Point to Orca wrapper dir

      const result = spawnSync('zsh', ['-c', 'echo "ORCA_ORIG_ZDOTDIR=${ORCA_ORIG_ZDOTDIR}"'], {
        env: cleanEnv as NodeJS.ProcessEnv,
        encoding: 'utf8'
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`ORCA_ORIG_ZDOTDIR=${testHome}`)
    })
  })
})
