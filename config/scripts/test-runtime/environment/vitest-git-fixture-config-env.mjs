import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// Per-checkout, user-owned: a predictable name in a shared /tmp could be planted by another user.
const CACHE_DIR = resolve(import.meta.dirname, '../../../../node_modules/.cache')

/**
 * Real-git fixtures run against a global config of their own, never the developer's: a user's
 * merge.ff, hooksPath, excludesFile, signing, includeIf or url rewrites changed fixture outcomes. Identity is
 * left to each fixture, as on CI; safe.directory keeps fixtures in other users' folders usable.
 */
export function gitFixtureConfigEnv() {
  const noExcludes = join(CACHE_DIR, 'orca-vitest-empty-excludes')
  const config = [
    '[core]',
    `\texcludesFile = ${JSON.stringify(noExcludes.replaceAll('\\', '/'))}`,
    '[safe]',
    '\tdirectory = *',
    '[commit]',
    '\tgpgsign = false',
    '[tag]',
    '\tgpgsign = false',
    '\tforceSignAnnotated = false',
    ''
  ].join('\n')
  const hash = createHash('sha256').update(config).digest('hex').slice(0, 16)
  const file = join(CACHE_DIR, `orca-vitest-git-config-${hash}.gitconfig`)
  if (!existsSync(noExcludes)) {
    mkdirSync(CACHE_DIR, { recursive: true })
    writeFileSync(noExcludes, '')
  }
  if (!existsSync(file)) {
    mkdirSync(CACHE_DIR, { recursive: true })
    // Concurrent runs may share the cache; rename so no git ever reads a half-written file.
    const partial = `${file}.${process.pid}`
    writeFileSync(partial, config)
    renameSync(partial, file)
  }
  return { GIT_CONFIG_GLOBAL: file, GIT_CONFIG_NOSYSTEM: '1' }
}
