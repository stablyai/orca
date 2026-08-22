import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every `wsl.exe` spawn must go through `runWslProcess`.
 *
 * Why a guard and not review: five decisions have to be made on each call
 * (separator, shell, stdout fencing, WSLENV, payload transport), each is
 * invisible in a diff, and each has shipped wrong. `wsl-exec-mode-separator`
 * already guards one of the five — this guards the call itself, so the other
 * four cannot be re-decided per site.
 *
 * The allowlist is the W3 migration worklist and only shrinks. Its length is
 * the workstream's measured goalpost.
 */
const ALLOWLIST: readonly string[] = readFileSync(
  join(__dirname, '__fixtures__', 'wsl-invocation-allowlist.txt'),
  'utf8'
)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'))

const SOURCE_ROOT = resolve(__dirname, '../..')
// Why the trailing slash: a bare 'main/wsl' prefix also exempts main/wsl.ts,
// main/wsl-availability.ts and main/wsl-unc-delete.ts -- three files that spawn
// wsl.exe directly. Caught by testing the guard against a planted call site.
const OWNER_DIRECTORY = 'main/wsl/'
const IGNORED = new Set(['node_modules', 'dist', 'out', 'build', '.git', '__fixtures__'])
/**
 * A spawn site: the `wsl.exe` literal sits directly in a spawn-family call, or
 * in a `program:` field. A bare mention (a shell-name constant, a type, a
 * comment) is not a call and is not the guard's business.
 */
const SPAWN_OPENER =
  /(?:spawn|spawnSync|execFile|execFileSync|exec|fork|runProcess|spawnProcess|execFileAsync|execAsync)\s*\(\s*$|program:\s*$/

function isTestFile(path: string): boolean {
  return (
    /\.(?:test|spec)\.tsx?$/.test(path) ||
    /(?:test-harness|test-utils|test-setup|test-fixture|repro)/.test(path)
  )
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED.has(entry) || entry.startsWith('.')) {
      continue
    }
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      found.push(...collectSourceFiles(path))
      continue
    }
    if (/\.tsx?$/.test(entry)) {
      found.push(path)
    }
  }
  return found
}

function findSpawnSites(): string[] {
  const offenders = new Set<string>()
  for (const path of collectSourceFiles(SOURCE_ROOT)) {
    const relativePath = relative(SOURCE_ROOT, path).replace(/\\/g, '/')
    if (isTestFile(relativePath) || relativePath.startsWith(OWNER_DIRECTORY)) {
      continue
    }
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/['"]wsl\.exe['"]/g)) {
      // Collapse the preceding whitespace so a call broken across lines by the
      // formatter still reads as one opener.
      const preceding = source.slice(Math.max(0, match.index - 60), match.index)
      if (SPAWN_OPENER.test(preceding.replace(/\s+/g, ' ').replace(/ $/, ''))) {
        offenders.add(relativePath)
      }
    }
  }
  return [...offenders].sort()
}

describe('wsl.exe is spawned through one runner', () => {
  const offenders = findSpawnSites()

  it('finds the call sites it is meant to guard', () => {
    // Guards against a detection change quietly emptying the scan, which would
    // make the assertions below pass without checking anything.
    expect(offenders.length + ALLOWLIST.length).toBeGreaterThanOrEqual(20)
  })

  it('adds no new direct wsl.exe spawn', () => {
    expect(offenders.filter((path) => !ALLOWLIST.includes(path))).toEqual([])
  })

  it('carries no stale allowlist entry', () => {
    // A migrated file must leave the list, or the goalpost stops moving.
    expect(ALLOWLIST.filter((path) => !offenders.includes(path))).toEqual([])
  })
})
