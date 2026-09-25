import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the ripgrep chokepoint at the tree level rather than per call site.
 *
 * Orca ships its own `rg` for every platform, so a spawn must name it by absolute path. A bare
 * `'rg'` is not merely slower: on Windows the spawn cwd is the user's repo, and CreateProcessW
 * looks there before PATH, so a planted `rg.exe` in a cloned repo would run instead.
 *
 * The allowlist only shrinks. Each entry is a deliberate PATH fallback that has to stay.
 */
// Empty on purpose: no production file names a bare `rg` AT a spawn site any more.
//
// What this guard cannot see, stated plainly so nobody reads the empty list as a stronger promise
// than it is: on POSIX `pathRipgrepCommand()` still RETURNS the bare name, and
// `probeRipgrepVersion` spawns it through a parameter. A textual guard cannot follow a value, and
// that case is safe regardless -- execvp never consults the cwd. The hazard is Windows-only, and
// the Windows branch of that same function resolves an absolute rg.exe instead.
const ALLOWED_BARE_RIPGREP_SPAWNS: readonly string[] = []

// A spawn/exec whose command argument is the literal 'rg', or the constant that holds it. Why the
// constant too: moving the bare name behind `PATH_RIPGREP_COMMAND` would otherwise hide it from
// this guard, and `spawn(PATH_RIPGREP_COMMAND, args, { cwd: userRepo })` is exactly the hijack
// this file exists to catch.
const BARE_SPAWN_PATTERN =
  /\b(?:wslAwareSpawn|runProcess|spawn|spawnSync|exec|execFile|execFileSync|execSync)\w*\(\s*(?:['"]rg['"]|PATH_RIPGREP_COMMAND)/

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

/** Drop comment-only lines so prose about the old idiom is not an offender. */
function codeText(contents: string): string {
  return contents
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .join('\n')
}

describe('bare ripgrep spawn boundary', () => {
  const repoRoot = resolve(__dirname, '..', '..', '..')
  const files = collectSourceFiles(join(repoRoot, 'src'))
  const offenders = files
    .map((file) => relative(repoRoot, file).split('\\').join('/'))
    .filter((path) => !isTestFile(path))
    .filter((path) => BARE_SPAWN_PATTERN.test(codeText(readFileSync(join(repoRoot, path), 'utf8'))))

  it.each(['wslAwareSpawn', 'spawnProcess', 'runProcess', 'spawn', 'execFile'])(
    'rejects a bare ripgrep command through %s',
    (spawnName) => {
      expect(BARE_SPAWN_PATTERN.test(`${spawnName}('rg', args, { cwd })`)).toBe(true)
      expect(BARE_SPAWN_PATTERN.test(`${spawnName}(PATH_RIPGREP_COMMAND, args)`)).toBe(true)
      expect(BARE_SPAWN_PATTERN.test(`${spawnName}(bundledCommand, args)`)).toBe(false)
    }
  )

  it('scans a plausible number of files', () => {
    // A broken root or extension list would make the guard silently vacuous.
    expect(files.length).toBeGreaterThan(500)
  })

  it('has no bare rg spawn outside the allowlist', () => {
    expect(
      offenders.filter((path) => !ALLOWED_BARE_RIPGREP_SPAWNS.includes(path)),
      "New bare 'rg' spawn. Use spawnBundledRipgrep (main) or resolveRelayRipgrepCommand (relay)."
    ).toEqual([])
  })

  it('has no stale allowlist entry', () => {
    // Why this direction too: a migrated file that stays listed hides the next regression there.
    expect(
      ALLOWED_BARE_RIPGREP_SPAWNS.filter((path) => !offenders.includes(path)),
      "Allowlist entry no longer spawns a bare 'rg' -- delete the line."
    ).toEqual([])
  })
})
