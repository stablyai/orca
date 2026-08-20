/**
 * Real-zsh proof that a wrapper dir holding files from two Orca builds still
 * loads the user's own zsh config.
 *
 * A shared dir used to mean a shell could read one build's `.zshenv` and
 * another's `.zprofile`/`.zshrc`/`.zlogin`, which is why every generated file
 * redefined the helpers it called. #15285 removed the hazard for the desktop and
 * daemon trees by naming each one after a hash of its contents, so two builds
 * never write the same directory.
 *
 * The relay is the one writer left on a fixed path — `~/.orca-relay/shell-ready`
 * — so this is where the scenario is still reachable, and it is now much smaller:
 * Orca writes one file, and that file hands ZDOTDIR back before anything else
 * runs. Both halves are pinned here:
 *
 * 1. Files an older build left beside the hook are inert — zsh reads .zprofile,
 *    .zshrc and .zlogin from the user's own directory and never from here.
 * 2. Generation does not delete them. An older build checks for all four before
 *    calling its tree complete; deleting them makes it rewrite its own `.zshenv`
 *    over ours, and an older `.zshenv` points ZDOTDIR at a directory that would
 *    then hold no `.zshrc` at all — the user losing their entire config, which is
 *    the failure this file exists to prevent.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureOverlayRestoreWrappers } from '../relay/pty-shell-overlay-wrappers'
import { hasZsh, makeZshHome, runZshPty } from './zsh-startup-hook-pty-harness'

const itWithZsh = hasZsh ? it : it.skip

/** The three files an older build wrote alongside its own `.zshenv`. */
const OLDER_BUILD_FILES = {
  '.zprofile': 'export ORCA_TEST_STALE_ZPROFILE=1\n',
  '.zshrc': 'export ORCA_TEST_STALE_ZSHRC=1\n',
  '.zlogin': 'export ORCA_TEST_STALE_ZLOGIN=1\n'
}

describe.skipIf(process.platform === 'win32')('zsh wrapper dir written by mixed builds', () => {
  itWithZsh('ignores an older build’s files and loads the user’s config instead', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-wrapper-mismatch-'))
    const home = makeZshHome({
      '.zshenv': 'export ORCA_TEST_USER_ZSHENV=1\n',
      '.zprofile': 'export ORCA_TEST_USER_ZPROFILE=1\n',
      '.zshrc': 'export ORCA_TEST_USER_ZSHRC=1\n'
    })
    try {
      expect(ensureOverlayRestoreWrappers(root)).toBe(true)
      const zshDir = join(root, 'zsh')
      for (const [name, content] of Object.entries(OLDER_BUILD_FILES)) {
        writeFileSync(join(zshDir, name), content)
      }

      const { values } = await runZshPty({
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          ZDOTDIR: zshDir,
          ORCA_ORIG_ZDOTDIR: home,
          ORCA_SHELL_FEATURES: 'history',
          ORCA_HISTFILE: join(home, 'scoped_history')
        },
        report: [
          'ORCA_TEST_USER_ZPROFILE',
          'ORCA_TEST_USER_ZSHRC',
          'ORCA_TEST_STALE_ZPROFILE',
          'ORCA_TEST_STALE_ZSHRC',
          'ORCA_TEST_STALE_ZLOGIN',
          'HISTFILE'
        ]
      })

      // The user's own files loaded; the older build's leftovers did not.
      expect(values.ORCA_TEST_USER_ZPROFILE).toBe('1')
      expect(values.ORCA_TEST_USER_ZSHRC).toBe('1')
      expect(values.ORCA_TEST_STALE_ZPROFILE).toBe('UNSET')
      expect(values.ORCA_TEST_STALE_ZSHRC).toBe('UNSET')
      expect(values.ORCA_TEST_STALE_ZLOGIN).toBe('UNSET')
      expect(values.HISTFILE).toBe(join(home, 'scoped_history'))
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('leaves an older build’s files in place so that build can still use them', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-wrapper-mismatch-keep-'))
    try {
      expect(ensureOverlayRestoreWrappers(root)).toBe(true)
      const zshDir = join(root, 'zsh')
      for (const [name, content] of Object.entries(OLDER_BUILD_FILES)) {
        writeFileSync(join(zshDir, name), content)
      }

      // A second generation pass is what an older build's launch would race.
      expect(ensureOverlayRestoreWrappers(root)).toBe(true)

      for (const [name, content] of Object.entries(OLDER_BUILD_FILES)) {
        expect(existsSync(join(zshDir, name))).toBe(true)
        expect(readFileSync(join(zshDir, name), 'utf8')).toBe(content)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
