// Why: the OpenCode hook service materializes one machine-generated config
// dir per session/source under userData and historically never removed them —
// a real machine accumulated ~35k files / 574MB of dead overlay state. This
// sweep bulk-removes clearly-dead dirs under a deliberately conservative
// policy: correctness beats reclaimed bytes, so anything ambiguous is kept
// (an individual leftover dir is cheap; the win is removing thousands).
import type { Dirent } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { safeRemoveTree } from '../pty/overlay-mirror'
import {
  OPENCODE_OVERLAY_MANIFEST_FILE,
  OPENCODE_SHARED_CONFIG_DIR,
  ORCA_OPENCODE_PLUGIN_FILE
} from './overlay-dir-names'

// Why: only dirs whose names Orca itself generated are ever candidates —
// 32-hex `toSafeDirName` hashes (current), plus the pre-#1155 numeric PTY
// counters that only ever existed under the legacy hooks root. Anything a
// human (or a future Orca version) placed here is out of reach of the sweep.
const GENERATED_HASH_DIR_NAME = /^[0-9a-f]{32}$/
const LEGACY_COUNTER_DIR_NAME = /^\d+$/

// Why: 30 days of no spawn against a dir means no live terminal has been
// using it; a session that resumes later self-heals because buildPtyEnv
// recreates the overlay from the recorded source config dir on every spawn.
export const OPENCODE_DIR_GC_MIN_AGE_MS = 30 * 24 * 60 * 60 * 1000
// Why: bound per-run work so a first sweep over a years-old backlog cannot
// monopolize the main process or thrash disk; later runs continue the job.
export const OPENCODE_DIR_GC_MAX_REMOVALS_PER_SWEEP = 500

export type OpenCodeDirGcOptions = {
  legacyHooksRoot: string
  overlayRoot: string
  // Config dirs handed out to any PTY during this app run (plus inherited
  // process.env values); these are live no matter what their mtimes say.
  referencedConfigDirs: ReadonlySet<string>
  now?: number
  minAgeMs?: number
  maxRemovals?: number
  removeTree?: (path: string) => void
  yieldBetweenRemovals?: () => Promise<void>
}

export type OpenCodeDirGcResult = {
  scanned: number
  removed: number
  keptReferenced: number
  keptYoung: number
  keptUnrecognized: number
  failed: number
}

function canonicalizeForComparison(path: string): string {
  const resolved = resolve(path)
  // Why: Windows paths compare case-insensitively; a casing mismatch between
  // an env-sourced reference and the scanned path must not defeat the check.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

// Why: the per-spawn plugin rewrite (and manifest write) updates file mtimes
// but NOT the parent dir's mtime, so the dir mtime alone under-reports
// recency — on a live machine the shared dir's own mtime was weeks old while
// its plugin file had been rewritten minutes earlier. Stat the fixed set of
// paths the hook service touches on every spawn and take the newest.
async function newestSpawnTouchedMtimeMs(dirPath: string): Promise<number> {
  const spawnTouchedPaths = [
    dirPath,
    join(dirPath, OPENCODE_OVERLAY_MANIFEST_FILE),
    join(dirPath, 'plugins'),
    join(dirPath, 'plugins', ORCA_OPENCODE_PLUGIN_FILE)
  ]
  let newest = 0
  for (const path of spawnTouchedPaths) {
    try {
      newest = Math.max(newest, (await lstat(path)).mtimeMs)
    } catch {
      // Missing entries contribute nothing to recency.
    }
  }
  return newest
}

export async function sweepOrphanedOpenCodeDirs(
  options: OpenCodeDirGcOptions
): Promise<OpenCodeDirGcResult> {
  const now = options.now ?? Date.now()
  const minAgeMs = options.minAgeMs ?? OPENCODE_DIR_GC_MIN_AGE_MS
  const maxRemovals = options.maxRemovals ?? OPENCODE_DIR_GC_MAX_REMOVALS_PER_SWEEP
  const removeTree = options.removeTree ?? safeRemoveTree
  const yieldBetweenRemovals =
    options.yieldBetweenRemovals ?? (() => new Promise<void>((r) => setImmediate(r)))
  const referencedDirs = [...options.referencedConfigDirs].map(canonicalizeForComparison)

  const result: OpenCodeDirGcResult = {
    scanned: 0,
    removed: 0,
    keptReferenced: 0,
    keptYoung: 0,
    keptUnrecognized: 0,
    failed: 0
  }

  const sweepRoots = [
    { root: options.legacyHooksRoot, allowNumericNames: true },
    { root: options.overlayRoot, allowNumericNames: false }
  ]

  for (const { root, allowNumericNames } of sweepRoots) {
    let entries: Dirent[]
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      // Why: count failed attempts against the bound too — a failed removal
      // may still have done significant IO before giving up.
      if (result.removed + result.failed >= maxRemovals) {
        return result
      }
      result.scanned++

      // Why: `shared` is the still-active no-user-config OPENCODE_CONFIG_DIR
      // (see writeSharedPluginConfig) — never a candidate, checked by name so
      // even a shape-rule bug cannot reach it.
      if (entry.name === OPENCODE_SHARED_CONFIG_DIR) {
        result.keptUnrecognized++
        continue
      }
      const isGeneratedName =
        GENERATED_HASH_DIR_NAME.test(entry.name) ||
        (allowNumericNames && LEGACY_COUNTER_DIR_NAME.test(entry.name))
      // Why: isSymbolicLink checked alongside isDirectory — a symlinked entry
      // is not Orca-generated and removing through it risks foreign data.
      if (!isGeneratedName || entry.isSymbolicLink() || !entry.isDirectory()) {
        result.keptUnrecognized++
        continue
      }

      const candidate = join(root, entry.name)
      const canonicalCandidate = canonicalizeForComparison(candidate)
      const isReferenced = referencedDirs.some(
        (dir) => dir === canonicalCandidate || dir.startsWith(canonicalCandidate + sep)
      )
      if (isReferenced) {
        result.keptReferenced++
        continue
      }

      const newestMtimeMs = await newestSpawnTouchedMtimeMs(candidate)
      // Why: newestMtimeMs === 0 means every stat failed (dir vanished or is
      // unreadable mid-sweep) — keep rather than guess.
      if (newestMtimeMs === 0 || now - newestMtimeMs < minAgeMs) {
        result.keptYoung++
        continue
      }

      try {
        removeTree(candidate)
        result.removed++
      } catch {
        // Why: one EBUSY/EPERM dir (antivirus, open handles) must not abort
        // the whole sweep; the dir stays and a later run retries it.
        result.failed++
      }
      await yieldBetweenRemovals()
    }
  }

  return result
}
