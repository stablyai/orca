import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_ROOT = join(__dirname, '..')
// Route keychain access through the run-wide guard so withheld keychains cannot block the main thread.
const ALLOWED = new Set(['host/safe-storage-availability.ts', 'host/electron-secret-store.ts'])

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSources(path)
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('electron.safeStorage importers', () => {
  it('stay behind the keychain withhold', () => {
    const importers = listSources(MAIN_ROOT)
      .filter((path) =>
        /import\s*\{[^}]*\bsafeStorage\b[^}]*\}\s*from\s*'electron'/.test(
          readFileSync(path, 'utf8')
        )
      )
      .map((path) => relative(MAIN_ROOT, path).split('\\').join('/'))
    expect(importers.filter((path) => !ALLOWED.has(path))).toEqual([])
  })
})
