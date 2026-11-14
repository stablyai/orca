import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export const repoRoot = path.resolve(import.meta.dirname, '../../..')
export const fixtureCacheDir = path.join(repoRoot, '.cache', 'fixtures')
export const serverStatePath = path.join(fixtureCacheDir, 'server.json')
export const serverLockPath = path.join(fixtureCacheDir, 'server.lock')
export const serverLogPath = path.join(fixtureCacheDir, 'server.log')
export const serverScriptPath = path.join(
  repoRoot,
  'config',
  'scripts',
  'component-fixtures',
  'fixture-server.mjs'
)

// Why: a detached server outlives edits to these scripts; clients restart it on mismatch.
export function fixtureServerCodeStamp() {
  const scriptDir = path.dirname(serverScriptPath)
  const configPath = path.join(repoRoot, 'config', 'vite.fixtures.config.ts')
  const files = [...readdirSync(scriptDir).map((name) => path.join(scriptDir, name)), configPath]
  return String(Math.max(...files.map((file) => statSync(file).mtimeMs)))
}

export function fixtureScreenshotPath(outDir, id, theme) {
  const fileStem = id
    .replaceAll('/', '__')
    .replaceAll(':', '--')
    .replace(/[^\w.-]/g, '_')
  return path.join(outDir, `${fileStem}.${theme}.png`)
}

// `*` matches within the id; a bare component id (no `:`) matches all of its fixtures.
export function matchFixtureIds(knownIds, pattern) {
  if (!pattern.includes('*')) {
    return knownIds.filter((id) => id === pattern || id.startsWith(`${pattern}:`))
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')
  const matcher = new RegExp(`^${escaped}$`)
  return knownIds.filter((id) => matcher.test(id))
}
