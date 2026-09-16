import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { enforceCodexConfigFileMode } from './codex-config-file-mode'

/**
 * A dangling `config.toml` symlink used to throw out of the mode repair and permanently disable
 * the whole config mirror.
 *
 * `lstat` SUCCEEDS on a dangling link — it describes the link, not the target — so
 * `resolveTomlWritePath` takes its symlink branch and `realpath` throws ENOENT. That escaped
 * `enforceCodexConfigFileMode`, was swallowed by the mirror's catch, and returned before any
 * mirror ran. Nothing self-corrects, so the user's `~/.codex` settings silently stopped reaching
 * Codex on every launch from then on.
 *
 * Why this needs a real symlink on disk: the existing `never throws` case in
 * codex-config-file-mode-warning.test.ts points at a path that simply does not exist, where
 * `lstat` throws ENOENT and the resolver swallows it and returns the lexical path. That test
 * looks like it guards this and cannot reach it — a merely absent path never enters the branch
 * that breaks.
 */
describe.skipIf(process.platform === 'win32')(
  'config file mode repair on a dangling symlink',
  () => {
    let dir: string | null = null

    afterEach(() => {
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
        dir = null
      }
    })

    function danglingConfigPath(): string {
      dir = mkdtempSync(join(tmpdir(), 'orca-codex-dangling-'))
      const configPath = join(dir, 'config.toml')
      symlinkSync(join(dir, 'target-that-does-not-exist.toml'), configPath)
      return configPath
    }

    it('does not throw, so the mirror is not disabled for every later pass', () => {
      const configPath = danglingConfigPath()

      expect(() => enforceCodexConfigFileMode(configPath, () => undefined)).not.toThrow()
    })

    it('reports the unresolvable path rather than failing silently', () => {
      const configPath = danglingConfigPath()
      const warnings: string[] = []

      enforceCodexConfigFileMode(configPath, (message) => warnings.push(message))

      // Pinned to the dangling-symlink reason specifically, not to "something threw": the warning
      // must name the config path and the realpath failure that produced it.
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain(configPath)
      expect(warnings[0]).toContain('realpath')
    })
  }
)
