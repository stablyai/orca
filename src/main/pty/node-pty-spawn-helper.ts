import { chmodSync, existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

// Keyed by root, not a single flag: the relay can load node-pty from the bundle and later from its
// deployed dir, and repairing one must not mark the other done.
const repairedPackageRoots = new Set<string>()
const REQUIRE_RESOLVED_ROOT = '<require-resolved>'

function toUnpackedAsarPath(candidate: string): string {
  return candidate
    .replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
    .replace(/node_modules\.asar([/\\])/, 'node_modules.asar.unpacked$1')
}

/**
 * node-pty's loader tries build/Release -> build/Debug -> prebuilds/<platform>-<arch> and spawns the
 * helper sitting next to whichever one it loaded, so every entry is a live candidate.
 */
export function getNodePtySpawnHelperCandidatesIn(packageRoot: string): string[] {
  return [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ].map(toUnpackedAsarPath)
}

export function getNodePtySpawnHelperCandidates(): string[] {
  const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js')
  const packageRoot =
    basename(unixTerminalPath) === 'unixTerminal.js'
      ? unixTerminalPath.replace(/[/\\]lib[/\\]unixTerminal\.js$/, '')
      : unixTerminalPath

  return getNodePtySpawnHelperCandidatesIn(packageRoot)
}

function resolveCandidates(packageRoot?: string): string[] {
  return packageRoot
    ? getNodePtySpawnHelperCandidatesIn(packageRoot)
    : getNodePtySpawnHelperCandidates()
}

/**
 * Ensure every installed node-pty spawn-helper has the executable bit set.
 *
 * Why: asar packaging and SFTP relay deploys both drop the +x bit, and the packaged
 * prebuilds/<platform>-<arch> helper ships 0644. posix_spawn on it fails with EACCES.
 *
 * @param packageRoot node-pty package dir to repair; omit to resolve it through require.
 */
export function ensureNodePtySpawnHelperExecutable(packageRoot?: string): void {
  if (process.platform === 'win32') {
    return
  }
  const repairKey = packageRoot ?? REQUIRE_RESOLVED_ROOT
  if (repairedPackageRoots.has(repairKey)) {
    return
  }
  repairedPackageRoots.add(repairKey)

  let candidates: string[]
  try {
    candidates = resolveCandidates(packageRoot)
  } catch (error) {
    console.warn(
      `[pty] Failed to resolve node-pty spawn-helper candidates: ${error instanceof Error ? error.message : String(error)}`
    )
    return
  }

  // Why every candidate, not just the first: the loader pairs the helper with the dir it loaded
  // from, so stopping at an already-+x build/Release leaves the 0644 prebuild helper to fail.
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) {
        continue
      }
      const mode = statSync(candidate).mode
      if ((mode & 0o111) === 0) {
        chmodSync(candidate, mode | 0o755)
      }
    } catch (error) {
      // Keep going: one unwritable candidate must not strand the dir node-pty actually picked.
      console.warn(
        `[pty] Failed to ensure node-pty spawn-helper is executable at ${candidate}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
}

/**
 * Per-candidate presence and mode, for spawn-failure messages.
 *
 * Why: upstream node-pty collapses every failing step of its spawn into one opaque
 * "posix_spawnp failed." Hosts that never get Orca's patched binary — every SSH relay, since
 * pnpm patches do not cross the SSH boundary — have to describe the helper themselves.
 */
export function describeNodePtySpawnHelperState(packageRoot?: string): string {
  let candidates: string[]
  try {
    candidates = resolveCandidates(packageRoot)
  } catch {
    return 'spawn-helper unresolved'
  }

  const described = candidates.map((candidate) => {
    try {
      const mode = statSync(candidate).mode
      const permissions = (mode & 0o777).toString(8)
      return (mode & 0o111) === 0
        ? `${candidate} (mode ${permissions}, NOT executable)`
        : `${candidate} (mode ${permissions})`
    } catch {
      return `${candidate} (absent)`
    }
  })
  return `spawn-helper: ${described.join('; ')}`
}
