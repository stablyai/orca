import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the gh chokepoint the way `child-process-import-boundary` guards spawn.
 *
 * `ghExecFileAsync` is what gives a gh invocation a deadline, a process-tree
 * kill, transient-error retry, the rate-limit breaker, and WSL/host routing.
 * Two call sites quietly opted out of all of it by reaching for the legacy
 * `execFileAsync('gh', …)`, and one of them left `gh` children spinning at 100%
 * CPU forever while permanently exhausting the GitHub concurrency semaphore
 * (#18234). Nothing about those call sites looked wrong locally — which is why
 * this is a tree-level rule rather than a review habit.
 *
 * The allowlist is empty and may only stay empty.
 */
const GH_SPAWN_PATTERN =
  /(?:execFileAsync|commandExecFileAsync|execFileCapture|runProcess|spawnProcess|execFile|spawnSync|spawn)\s*\(\s*(['"`])gh\1|program:\s*(['"`])gh\2/

// Why trailing slash: a sibling like command-runner-extras.ts is scanned, not exempted.
const OWNER_DIRECTORY = 'src/main/git/command-runner/'
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function collectSourceFiles(root: string): string[] {
  let found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return found
  }
  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found = found.concat(collectSourceFiles(full))
      continue
    }
    if (SCANNED_EXTENSIONS.some((extension) => full.endsWith(extension))) {
      found.push(full)
    }
  }
  return found
}

describe('gh spawn boundary', () => {
  it('routes every gh invocation through ghExecFileAsync', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..', '..')
    const offenders = collectSourceFiles(join(repoRoot, 'src'))
      .map((path) => relative(repoRoot, path).split('\\').join('/'))
      .filter((path) => !isTestFile(path) && !path.startsWith(OWNER_DIRECTORY))
      .filter((path) => GH_SPAWN_PATTERN.test(readFileSync(join(repoRoot, path), 'utf8')))

    expect(offenders).toEqual([])
  })
})
