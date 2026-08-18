/**
 * Real-zsh proof that a wrapper dir written by two different Orca builds still
 * loads the user's own zsh config.
 *
 * One wrapper dir (`<userData>/shell-ready/zsh`, or `~/.orca-relay/shell-ready/
 * zsh` for a remote host) is shared by every concurrently installed build, and
 * each rewrites it on spawn. A shell can therefore read one build's `.zshenv`
 * and another's `.zprofile`/`.zshrc`/`.zlogin`. Only a real zsh shows the cost:
 * a helper the newer files call but the older `.zshenv` never defined both
 * prints `command not found` into the pane AND leaves `$REPLY` empty, which
 * silently skips sourcing the user's own startup files.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureShellReadyWrappersAt } from './providers/local-pty-shell-ready-wrapper-generation'

const hasZsh = process.platform !== 'win32' && spawnSync('zsh', ['--version']).status === 0
const ZSH_PATH = hasZsh
  ? (spawnSync('sh', ['-c', 'command -v zsh'], { encoding: 'utf8' }).stdout || '').trim()
  : ''
const itWithZsh = hasZsh ? it : it.skip

/**
 * A `.zshenv` from a build that predates everything the other three files now
 * call: it exports the wrapper ZDOTDIR and nothing else.
 */
function olderBuildZshenv(zshDir: string): string {
  return `# Orca zsh shell-ready wrapper
export ORCA_ORIG_ZDOTDIR="$HOME"
export ZDOTDIR=${JSON.stringify(zshDir)}
`
}

describe.skipIf(process.platform === 'win32')('zsh wrapper dir written by mixed builds', () => {
  itWithZsh('still sources the user config when the .zshenv is from an older build', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-wrapper-mismatch-'))
    const home = mkdtempSync(join(tmpdir(), 'orca-wrapper-mismatch-home-'))
    try {
      expect(ensureShellReadyWrappersAt(root)).toBe(true)
      const zshDir = join(root, 'zsh')
      writeFileSync(join(zshDir, '.zshenv'), olderBuildZshenv(zshDir))
      for (const file of ['.zprofile', '.zshrc', '.zlogin']) {
        writeFileSync(join(home, file), `echo "RAN ${file}"\n`)
      }

      const result = spawnSync(ZSH_PATH, ['-l', '-i', '-c', 'exit 0'], {
        encoding: 'utf8',
        timeout: 20_000,
        env: { PATH: '/usr/bin:/bin', HOME: home, ZDOTDIR: zshDir }
      })
      // Why both streams: zsh prints `command not found` on stderr and the
      // fixture files echo on stdout, and this asserts about each.
      const output = `${result.stdout}${result.stderr}`

      expect(output).not.toContain('command not found')
      expect(output).toContain('RAN .zprofile')
      expect(output).toContain('RAN .zshrc')
      expect(output).toContain('RAN .zlogin')
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })
})
