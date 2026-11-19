import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { FileWithMtime } from '../session-scanner-types'

export type SessionDiscoveredFile = {
  file: Omit<FileWithMtime, 'modifiedAt'>
  sidecarPath?: string
}

/** The stat a file was last indexed with; the owner already retains it, so the cache copies nothing. */
export type SessionCommittedStat = {
  mtimeMs: number
  sizeBytes: number | null
  identity: { dev: number; ino: number } | null
}

/** `skip` counts the passes left before a directory that keeps changing is probed again. */
type DirectoryObservation = { mtimeMs: number; observedAt: number; changes: number; skip: number }

type QuietStat = SessionCommittedStat & { sizeBytes: number }

// A directory changed this close to its observation may change again within the same mtime tick.
const DIRECTORY_MTIME_GRANULARITY_MS = 2_000
// A directory that changes between probes saves nothing, so its probes back off to about one per sweep.
const DIRECTORY_PROBE_BACKOFF_MAX_PASSES = 15

/**
 * Lets a walk reuse the committed stat of a quiet file. Directory mtimes expose creates, deletes
 * and atomic renames; an in-place write to a quiet file waits for the owner's next complete restat.
 */
export class SessionDiscoveryStatCache {
  /** One baseline per probed directory, which only directories with several quiet files get. */
  private readonly directories = new Map<string, DirectoryObservation>()
  /** Directory observations of the running pass; an unfinished pass must not mark them seen. */
  private readonly pending = new Map<string, DirectoryObservation | null>()
  /** Probed directories unchanged since their baseline; only their files reuse stats this pass. */
  private readonly unchanged = new Set<string>()
  /** Files whose last stat failed or differed from their committed row stay restat until it matches. */
  private unsettled = new Set<string>()
  /** A complete restat rebuilds `unsettled` here so vanished paths are not retained. */
  private readonly restatUnsettled = new Set<string>()
  /** Files last modified before this count as quiet. */
  private quietBeforeMs = Number.NEGATIVE_INFINITY
  /** A complete restat reuses nothing and probes nothing; it keeps the baselines of directories it lists. */
  private reuse = false

  constructor(private readonly committed: (path: string) => SessionCommittedStat | undefined) {}

  beginPass(quietBeforeMs: number, reuse: boolean): void {
    this.quietBeforeMs = quietBeforeMs
    this.reuse = reuse
    this.unchanged.clear()
    this.pending.clear()
    this.restatUnsettled.clear()
  }

  /** Call only after the pass finished walking; an aborted walk leaves its directories unseen. */
  endPass(): void {
    if (!this.reuse) {
      // A complete restat listed every directory and stat every file, so drop what it did not see.
      this.directories.clear()
      this.unsettled = new Set(this.restatUnsettled)
      this.restatUnsettled.clear()
    }
    for (const [path, observation] of this.pending) {
      if (observation) {
        this.directories.set(path, observation)
      } else {
        this.directories.delete(path)
      }
    }
    this.pending.clear()
    this.unchanged.clear()
  }

  /** Probe a directory only when it can save more file stats than the probe costs. */
  wantsDirectoryMtime(path: string, entries: readonly Dirent[]): boolean {
    if (!this.reuse || (this.directories.get(directoryKey(path))?.skip ?? 0) > 0) {
      return false
    }
    let quiet = 0
    for (const entry of entries) {
      if (entry.isFile() && this.quietRow(join(path, entry.name)) && ++quiet >= 2) {
        return true
      }
    }
    return false
  }

  /** Call after listing; a null mtime (unprobed or unreadable) leaves the entries to be restat. */
  observeDirectory(path: string, mtimeMs: number | null): void {
    const key = directoryKey(path)
    const previous = this.directories.get(key)
    if (mtimeMs === null) {
      if (!previous) {
        return
      }
      // A complete restat or a backed-off probe keeps the baseline; any other unprobed listing drops it.
      if (!this.reuse) {
        this.pending.set(key, previous)
      } else {
        this.pending.set(key, previous.skip > 0 ? { ...previous, skip: previous.skip - 1 } : null)
      }
      return
    }
    // The granularity guard also covers a change between the listing and this later stat.
    const unchanged =
      previous?.mtimeMs === mtimeMs &&
      previous.observedAt - previous.mtimeMs >= DIRECTORY_MTIME_GRANULARITY_MS
    // Any probe that grants no reuse counts, including mtimes too close to or after their observation.
    const changes = previous && !unchanged ? previous.changes + 1 : 0
    this.pending.set(key, {
      mtimeMs,
      observedAt: Date.now(),
      changes,
      skip: Math.min(2 ** changes - 1, DIRECTORY_PROBE_BACKOFF_MAX_PASSES)
    })
    if (unchanged) {
      this.unchanged.add(key)
    }
  }

  reusable(path: string): SessionDiscoveredFile | undefined {
    if (!this.reuse || this.unchanged.size === 0 || !this.unchanged.has(dirname(path))) {
      return undefined
    }
    const row = this.quietRow(path)
    if (!row) {
      return undefined
    }
    return {
      file: {
        path,
        mtimeMs: row.mtimeMs,
        sizeBytes: row.sizeBytes,
        sidecar: 'none',
        // Rows lack link counts; reporting a possible link lets Codex alias collapsing compare
        // the inodes of same-name files, as a fresh stat of a linked file would.
        ...(row.identity ? { dev: row.identity.dev, ino: row.identity.ino, nlink: 2 } : {})
      }
    }
  }

  /** Record a fresh stat; null means it failed. */
  observed(path: string, observation: SessionDiscoveredFile | null): void {
    const row = this.committed(path)
    if (!observation || (row && !matchesRow(row, observation.file))) {
      // A deferred read of a changed file must not be skipped by reusing its stale row next pass.
      this.unsettled.add(path)
      if (!this.reuse) {
        this.restatUnsettled.add(path)
      }
    } else if (this.unsettled.size > 0) {
      this.unsettled.delete(path)
    }
  }

  private quietRow(path: string): QuietStat | undefined {
    if (this.unsettled.has(path)) {
      return undefined
    }
    const row = this.committed(path)
    // Device 0 comes from filesystems whose inodes may repeat, so only a fresh link count is proof.
    return row && isQuiet(row, this.quietBeforeMs) && row.identity?.dev !== 0 ? row : undefined
  }
}

// Directory keys match dirname() of the paths the walk joins under them.
function directoryKey(path: string): string {
  return dirname(join(path, '-'))
}

function isQuiet(row: SessionCommittedStat, quietBeforeMs: number): row is QuietStat {
  return row.sizeBytes !== null && row.mtimeMs < quietBeforeMs
}

function matchesRow(row: SessionCommittedStat, file: SessionDiscoveredFile['file']): boolean {
  return (
    row.mtimeMs === file.mtimeMs &&
    row.sizeBytes === (file.sizeBytes ?? null) &&
    (!row.identity || (row.identity.dev === file.dev && row.identity.ino === file.ino))
  )
}
