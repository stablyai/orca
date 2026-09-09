import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The ratchet behind the guard's claim to be a choke point.
 *
 * `admitSelfInitiatedTreeKill` is only "one decision" for as long as every
 * pid-addressed `taskkill /pid <pid> /t /f` in Electron main asks it. Each such
 * kill can land on a recycled pid that is now one of Orca's own Chromium
 * processes (#10680), and an ungated one is also invisible to
 * `selfInitiatedTreeKillCount`, which makes a zero read as exculpatory when it
 * is not. A new family fails here rather than in the field.
 *
 * Exactly what is enforced, so no comment elsewhere claims more: per file, the
 * number of gate admissions must be at least the number of `/pid` call sites.
 * Counting sites rather than files is the point — a file-granular scan would let
 * a second, ungated taskkill land inside a family that already mentions the gate,
 * which is the shape the six highest-risk files now have. What it still cannot
 * see: a site that pairs an ungated kill with a second admission of an already
 * gated one in the same file, and a kill whose `/pid` argument is itself built
 * from a variable.
 */
const REPOSITORY_ROOT = resolve(__dirname, '..', '..')
const MAIN_DIRECTORY = 'src/main/'
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

/**
 * One match per call site. Keyed on the `/pid` argument rather than the program
 * name because `/pid <n>` is what makes the kill pid-addressed — it walks
 * whatever tree owns that pid *now* — and because the literal survives a
 * `taskkill` spawned through a constant or a variable, which a quoted-program
 * pattern misses entirely.
 */
const PID_ADDRESSED_KILL_SITE = /['"]\/pid['"]/gi

/**
 * A call, not an import or a comment: `admitSelfInitiatedTreeKill` in main, and
 * `admitProcessTreeKill` for the `src/shared` seam main installs the same gate
 * into, which shared code cannot import directly.
 */
const GATE_ADMISSION = /\badmit(?:SelfInitiatedTreeKill|ProcessTreeKill)\s*\(/g

function countMatches(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0
}

/** Sites left over once each admission in the file has claimed one. */
function ungatedKillSiteCount(source: string): number {
  return Math.max(
    countMatches(source, PID_ADDRESSED_KILL_SITE) - countMatches(source, GATE_ADMISSION),
    0
  )
}

/**
 * Only ever shrinks. Each entry states why the gate cannot reach it — never
 * "not got to yet", which is what a new ungated family would also look like.
 */
const UNGATED_TASKKILL_ALLOWLIST = new Map<string, string>([
  [
    'src/main/browser/browser-route-egress-electron-launch.ts',
    'Electron probe reached only from *.electron.test.ts; kills the probe Electron it spawned'
  ],
  [
    'src/main/browser/browser-route-persisted-worker-electron-process.ts',
    'Electron probe reached only from *.electron.test.ts; kills the probe Electron it spawned'
  ],
  [
    'src/cli/handlers/interactive-login-interruption.ts',
    'CLI host: no Chromium pid on the machine to reach, and no reader for the ring'
  ],
  [
    'src/relay/subprocess-tree-termination.ts',
    'Relay host: same, and the relay cannot import the main-process gate'
  ]
])

function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || /(?:test-harness|test-fixture|fixture)/.test(path)
}

function scanSourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      scanSourceFiles(path, found)
      continue
    }
    if (SCANNED_EXTENSIONS.some((extension) => entry.endsWith(extension)) && !isTestFile(path)) {
      found.push(path)
    }
  }
  return found
}

// Only the Node-side hosts: a renderer or preload cannot spawn a process at all.
const SCANNED_HOSTS = ['src/main', 'src/shared', 'src/cli', 'src/relay']

/** Scanned once at import: 10k files is seconds, and every case below reuses it. */
const PID_ADDRESSED_KILL_FILES = SCANNED_HOSTS.flatMap((host) =>
  scanSourceFiles(join(REPOSITORY_ROOT, host))
    .map((path) => ({
      path: relative(REPOSITORY_ROOT, path).split('\\').join('/'),
      source: readFileSync(path, 'utf8')
    }))
    .filter((file) => countMatches(file.source, PID_ADDRESSED_KILL_SITE) > 0)
)

function pidAddressedKillFiles(): { path: string; source: string }[] {
  return PID_ADDRESSED_KILL_FILES
}

describe('main-process tree-kill gate', () => {
  it('finds the taskkill families it is meant to police', () => {
    // Falsifiable: a scanner that matched nothing would pass every case below.
    expect(pidAddressedKillFiles().map((file) => file.path)).toContain(
      'src/main/windows-process-tree-kill.ts'
    )
  })

  it('routes every pid-addressed taskkill in Electron main through the gate', () => {
    const ungated = pidAddressedKillFiles()
      .filter((file) => file.path.startsWith(MAIN_DIRECTORY))
      .filter((file) => ungatedKillSiteCount(file.source) > 0)
      .map((file) => file.path)
      .filter((path) => !UNGATED_TASKKILL_ALLOWLIST.has(path))

    expect(ungated).toEqual([])
  })

  it('leaves no pid-addressed taskkill outside main unaccounted for', () => {
    const unaccounted = pidAddressedKillFiles()
      .filter((file) => !file.path.startsWith(MAIN_DIRECTORY))
      .filter((file) => ungatedKillSiteCount(file.source) > 0)
      .map((file) => file.path)
      .filter((path) => !UNGATED_TASKKILL_ALLOWLIST.has(path))

    expect(unaccounted).toEqual([])
  })

  it('counts call sites, not files: a second ungated kill in a gated file is caught', () => {
    // The failure a file-granular scan let through: one gate mention exempting
    // every taskkill in the file.
    const gated = `
      import { admitSelfInitiatedTreeKill } from './own-chromium-tree-kill-guard'
      if (admitSelfInitiatedTreeKill({ pid, site: 's', scope: 'win-taskkill-tree' })) {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'])
      }
    `

    expect(ungatedKillSiteCount(gated)).toBe(0)
    expect(
      ungatedKillSiteCount(`${gated}\nspawn('taskkill', ['/pid', String(other), '/t', '/f'])`)
    ).toBe(1)
  })

  it('sees a kill whose program name comes from a constant', () => {
    // A quoted-program pattern misses this shape; the `/pid` argument does not.
    expect(
      ungatedKillSiteCount(`
        const KILLER = 'taskkill'
        spawn(KILLER, ['/pid', String(pid), '/t', '/f'])
      `)
    ).toBe(1)
  })

  it('keeps the allowlist honest: every entry still spawns a taskkill', () => {
    const spawning = new Set(pidAddressedKillFiles().map((file) => file.path))

    expect([...UNGATED_TASKKILL_ALLOWLIST.keys()].filter((path) => !spawning.has(path))).toEqual([])
  })
})
