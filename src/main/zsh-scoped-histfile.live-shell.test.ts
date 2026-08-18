/**
 * Real-zsh proof that a worktree-scoped HISTFILE survives shell startup.
 *
 * macOS `/etc/zshrc` assigns `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` with no
 * check-before-set, and it runs before every wrapper file Orca controls. So the
 * value `injectHistoryEnv` put in the spawn env is already gone by the time the
 * user reaches a prompt — and because ZDOTDIR still points at Orca's wrapper
 * dir, the replacement lands inside it. Per-worktree history was therefore a
 * silent no-op on the primary platform (#11044).
 *
 * Only a real zsh can show this: the string the wrapper emits looks correct
 * either way, and the whole bug lives in what /etc/zshrc does between the spawn
 * env and the first prompt.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getZshShellReadyRcfileContent } from './providers/local-pty-shell-ready-wrapper-generation'
import { getZshEnvTemplate, ZSH_HISTFILE_RESTORE_BLOCK } from './shell-templates'

// Why probe and execute the same binary: guarding on `zsh` from PATH but then
// running a hardcoded `/bin/zsh` lets the guard pass on a host that installs zsh
// elsewhere, and the test fails for a missing binary rather than a wrapper
// defect. The absolute path is resolved once so the sandboxed PATH below cannot
// lose it.
const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const ZSH_PATH = hasZsh
  ? (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout || '').trim()
  : ''
const itWithZsh = hasZsh ? it : it.skip

function runLoginZsh(home: string, zdotdir: string, env: Record<string, string>): string {
  // -o noglobalrcs is deliberately NOT passed: /etc/zshrc is the thing under test.
  return execFileSync(ZSH_PATH, ['-li', '-c', 'echo "RESULT=$HISTFILE"'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      ZDOTDIR: zdotdir,
      ORCA_ORIG_ZDOTDIR: home,
      ORCA_ZSHENV_SOURCE_DIR: home,
      ...env
    }
  })
}

describe('worktree-scoped HISTFILE survives zsh startup', () => {
  const withWrapper = (run: (home: string, zdotdir: string) => void): void => {
    const home = mkdtempSync(join(tmpdir(), 'orca-scoped-histfile-'))
    const zdotdir = join(home, 'shell-ready', 'zsh')
    mkdirSync(zdotdir, { recursive: true })
    writeFileSync(join(zdotdir, '.zshenv'), getZshEnvTemplate(zdotdir))
    writeFileSync(join(zdotdir, '.zshrc'), getZshShellReadyRcfileContent())
    writeFileSync(join(zdotdir, '.zlogin'), `${ZSH_HISTFILE_RESTORE_BLOCK}\n`)
    try {
      run(home, zdotdir)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }

  itWithZsh('keeps the injected path that a system zshrc would otherwise clobber', () => {
    withWrapper((home, zdotdir) => {
      const scoped = join(home, 'orca-history', 'zsh_history')

      const output = runLoginZsh(home, zdotdir, { HISTFILE: scoped, ORCA_HISTFILE: scoped })

      expect(output).toContain(`RESULT=${scoped}`)
    })
  })

  itWithZsh('never leaves history inside Orca’s own wrapper directory', () => {
    withWrapper((home, zdotdir) => {
      const scoped = join(home, 'orca-history', 'zsh_history')

      const output = runLoginZsh(home, zdotdir, { HISTFILE: scoped, ORCA_HISTFILE: scoped })

      // The exact failure mode of #11044: history written into shell-ready/zsh.
      expect(output).not.toContain(zdotdir)
    })
  })

  itWithZsh('leaves HISTFILE exactly as an unwrapped zsh would when Orca injects nothing', () => {
    // Why compared against an unwrapped run rather than asserted non-empty: what
    // zsh defaults to is platform-specific. macOS `/etc/zshrc` assigns HISTFILE,
    // so it is always set there; a stock Ubuntu zsh has no such file and leaves
    // it EMPTY. The contract is that Orca's wrapper does not change it either
    // way, which is the same assertion on both.
    withWrapper((home, zdotdir) => {
      const wrapped = runLoginZsh(home, zdotdir, {})
      const unwrapped = execFileSync(ZSH_PATH, ['-li', '-c', 'echo "RESULT=$HISTFILE"'], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: '/usr/bin:/bin', HOME: home }
      })

      const histfileOf = (output: string): string =>
        /^RESULT=(.*)$/m.exec(output)?.[1]?.trim() ?? '<unmatched>'
      expect(histfileOf(wrapped)).toBe(histfileOf(unwrapped))
      expect(wrapped).not.toContain('ORCA_HISTFILE')
    })
  })
})
