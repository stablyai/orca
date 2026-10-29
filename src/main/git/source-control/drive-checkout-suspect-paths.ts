import * as path from 'node:path'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'

// Minimal checkStat can miss same-size writes preserving whole-second mtime; recheck watcher paths with default stat.

// At ~8ms per path, cap a poll's extra recheck cost near 2.4s.
export const DRIVE_CHECKOUT_SUSPECT_LIMIT = 300

export type SuspectDegradeReason =
  | 'no-watcher'
  | 'watcher-restart'
  | 'watcher-interrupted'
  | 'over-limit'

/** A live watcher subscription; compared by identity, so a reinstall reads as a restart. */
export type SuspectWatchRoot = { readonly rootPath: string }

export type SuspectWatchEvent = { readonly type: string; readonly path: string }

// Why `confirmed`: a recheck proved the file dirty, which no lost watcher event can undo.
type Suspect = { seq: number; root: SuspectWatchRoot | null; confirmed: boolean }

function splitSegments(value: string, windows: boolean): string[] {
  return value.split(windows ? /[\\/]+/ : /\/+/).filter((segment) => segment.length > 0)
}

function sameSegment(a: string, b: string, windows: boolean): boolean {
  return windows ? a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase() : a === b
}

/** Preserve the reported tail via segment matching; reject repo roots, outside paths and .git. */
export function repoRelativeWatcherPath(repoPath: string, eventPath: string): string | null {
  const windows = isWindowsAbsolutePathLike(repoPath)
  const pathApi = windows ? path.win32 : path.posix
  if (windows !== isWindowsAbsolutePathLike(eventPath)) {
    return null
  }
  const repoSegments = splitSegments(pathApi.resolve(repoPath), windows)
  const eventSegments = splitSegments(pathApi.resolve(eventPath), windows)
  if (eventSegments.length <= repoSegments.length) {
    return null
  }
  for (let index = 0; index < repoSegments.length; index += 1) {
    if (!sameSegment(repoSegments[index], eventSegments[index], windows)) {
      return null
    }
  }
  const tail = eventSegments.slice(repoSegments.length)
  if (tail.some((segment) => sameSegment(segment, '.git', windows))) {
    return null
  }
  return tail.join('/')
}

function covers(root: SuspectWatchRoot, repoPath: string): boolean {
  const windows = isWindowsAbsolutePathLike(repoPath)
  const pathApi = windows ? path.win32 : path.posix
  const rootSegments = splitSegments(pathApi.resolve(root.rootPath), windows)
  const repoSegments = splitSegments(pathApi.resolve(repoPath), windows)
  return (
    windows === isWindowsAbsolutePathLike(root.rootPath) &&
    rootSegments.length <= repoSegments.length &&
    rootSegments.every((segment, index) => sameSegment(segment, repoSegments[index], windows))
  )
}

export class DriveCheckoutSuspectPaths {
  private boundRoot: SuspectWatchRoot | null = null
  private readonly suspects = new Map<string, Suspect>()
  private seq = 0
  lastDegradeReason: SuspectDegradeReason | null = null
  degradeCount = 0

  constructor(
    readonly repoPath: string,
    private readonly limit = DRIVE_CHECKOUT_SUSPECT_LIMIT
  ) {}

  get size(): number {
    return this.suspects.size
  }

  paths(): string[] {
    return [...this.suspects.keys()]
  }

  recordEvents(root: SuspectWatchRoot, events: readonly SuspectWatchEvent[]): void {
    if (!covers(root, this.repoPath)) {
      return
    }
    for (const event of events) {
      // Why: a deleted file fails lstat, which minimal status already reports.
      if (event.type === 'delete') {
        continue
      }
      const relativePath = repoRelativeWatcherPath(this.repoPath, event.path)
      if (relativePath === null) {
        continue
      }
      if (!this.suspects.has(relativePath) && this.suspects.size >= this.limit) {
        this.degrade('over-limit')
        if (this.suspects.size >= this.limit) {
          // Why skip rather than clear: confirmed paths are rechecked every poll, so the set drains.
          continue
        }
      }
      this.seq += 1
      this.suspects.set(relativePath, {
        seq: this.seq,
        root,
        confirmed: this.suspects.get(relativePath)?.confirmed ?? false
      })
    }
  }

  recordInterruption(root: SuspectWatchRoot): void {
    if (covers(root, this.repoPath)) {
      this.degrade('watcher-interrupted')
    }
  }

  /** Snapshot suspects by event sequence; confirmed-dirty paths remain eligible without a live watcher. */
  beginPoll(currentRoot: SuspectWatchRoot | null): Map<string, number> | null {
    if (currentRoot === null) {
      if (this.boundRoot !== null || this.lastDegradeReason !== 'no-watcher') {
        this.degrade('no-watcher')
      }
      this.boundRoot = null
    } else if (currentRoot !== this.boundRoot) {
      if (this.boundRoot !== null) {
        this.markDegraded('watcher-restart')
      }
      this.boundRoot = currentRoot
      // Why keep the new root's own events: they arrived after it was live, so nothing was missed for them.
      for (const [relativePath, suspect] of this.suspects) {
        if (suspect.root !== currentRoot && !suspect.confirmed) {
          this.suspects.delete(relativePath)
        }
      }
    }
    if (this.suspects.size === 0) {
      return null
    }
    return new Map([...this.suspects].map(([relativePath, { seq }]) => [relativePath, seq]))
  }

  /** Forgets a suspect unless a newer event re-armed it after `seq`. */
  drop(relativePath: string, seq: number): void {
    if (this.suspects.get(relativePath)?.seq === seq) {
      this.suspects.delete(relativePath)
    }
  }

  /** Keeps a rechecked-dirty path until a later recheck proves it clean. */
  confirmDirty(relativePath: string, seq: number): void {
    const suspect = this.suspects.get(relativePath)
    if (suspect) {
      suspect.confirmed = true
      return
    }
    // Why re-add: a degrade during the recheck removed it, but the recheck's proof still holds.
    if (this.suspects.size < this.limit) {
      this.suspects.set(relativePath, { seq, root: null, confirmed: true })
    }
  }

  private degrade(reason: SuspectDegradeReason): void {
    for (const [relativePath, suspect] of this.suspects) {
      if (!suspect.confirmed) {
        this.suspects.delete(relativePath)
      }
    }
    this.markDegraded(reason)
  }

  private markDegraded(reason: SuspectDegradeReason): void {
    this.lastDegradeReason = reason
    this.degradeCount += 1
  }
}
