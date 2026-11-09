import {
  SessionInventoryDirectories,
  type SessionInventoryDirectory as Directory
} from './session-file-inventory-directories'
import type { Dirent } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  isMissingTranscriptPathError,
  observeSessionFile,
  type DiscoverSessionFilesArgs
} from './session-scanner-discovery'
import type { FileWithMtime } from './session-scanner-types'
import { isDiscoverableSessionFile, isInsideSessionRoot } from './session-file-discovery'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import { retainRecentSessionFile } from './session-file-observation'
import { sidecarUnchanged } from './parse-cache/session-sidecar-stat'

export type SessionFileChange = { file: FileWithMtime; force: boolean }
type Walk = {
  path: string
  depth: number
  entries?: Dirent[]
  offset: number
  reconcile: boolean
  previous?: Directory
}

/** Retains discovery position independently of the read queue and of watcher delivery. */
export class SessionFileInventory {
  readonly files = new Map<string, FileWithMtime>()
  readonly dependencies = new Map<string, Set<string>>()
  private readonly directories: SessionInventoryDirectories
  private readonly dirty = new Map<string, boolean>()
  private readonly walks: Walk[] = []
  private readonly scheduled = new Set<string>()
  private readonly trailing = new Set<string>()
  private readonly recent = new Map<string, FileWithMtime>()
  private readonly dependencyByFile = new Map<string, string>()
  private readonly changes = new Map<string, SessionFileChange>()
  private readonly removed = new Set<string>()
  private readonly failures = new Set<string>()
  private reconcileAgain = false

  constructor(readonly root: string) {
    this.directories = new SessionInventoryDirectories(root)
    this.reconcile()
  }

  get pending(): boolean {
    return this.walks.length > 0 || this.dirty.size > 0 || this.reconcileAgain
  }

  reconcile(): void {
    // A burst during a crawl leaves one trailing obligation, never restarts its prefix.
    if (!this.scheduled.has(this.root)) {
      this.schedule(this.root, true)
    }
  }

  invalidate(path: string, force = true): void {
    if (this.dirty.size >= 16_384) {
      this.reconcile()
      this.reconcileAgain = true
      return
    }
    this.dirty.set(path, (this.dirty.get(path) ?? false) || force)
  }

  private schedule(path: string, reconcile = false): void {
    if (this.scheduled.has(path)) {
      return
    }
    const rel = relative(this.root, path)
    this.walks.push({ path, depth: rel ? rel.split(/[\\/]/).length : 0, offset: 0, reconcile })
    this.scheduled.add(path)
  }

  async pollRecent(args: DiscoverSessionFilesArgs, limit: number): Promise<void> {
    // This set is bounded on admission; never project/sort the archive to find recent paths.
    const paths = [...this.recent.keys()]
    for (const path of paths) {
      await this.observe(path, args, false, limit)
    }
  }

  async drain(
    args: DiscoverSessionFilesArgs,
    overdue: () => boolean,
    recentLimit: number
  ): Promise<{ changes: SessionFileChange[]; removed: string[] }> {
    let consumed = 0
    // Events arriving during an await stay in dirty; deleting before reading preserves their version.
    for (let index = 0; index < 16_384 && this.dirty.size; index++) {
      if (consumed > 0 && overdue()) {
        break
      }
      const first = this.dirty.entries().next().value
      if (!first) {
        break
      }
      const [path, force] = first
      this.dirty.delete(path)
      const owners = this.dependencies.get(path)
      if (owners) {
        for (const owner of owners) {
          this.invalidate(owner, force)
        }
      }
      if (this.accepts(path, args)) {
        await this.observe(path, args, force, recentLimit)
      } else if (isInsideSessionRoot(this.root, path)) {
        try {
          if ((await wslGatedStat(path, 'scan', args.signal)).isDirectory()) {
            if (this.scheduled.has(path)) {
              this.trailing.add(path)
            } else {
              this.schedule(path)
            }
          } else if (this.directories.has(path)) {
            this.schedule(dirname(path))
          }
        } catch (error) {
          throwIfAiVaultScanCancelled(args.signal)
          if (isMissingTranscriptPathError(error)) {
            this.schedule(dirname(path))
          } else {
            this.issue(path, error, args)
          }
        }
      }
      consumed++
    }
    while (this.walks.length && (consumed === 0 || !overdue())) {
      throwIfAiVaultScanCancelled(args.signal)
      const walk = this.walks.at(-1)!
      if (!walk.entries) {
        try {
          walk.entries = await wslGatedReaddir(walk.path, 'scan', args.signal)
          args.onDirectoryEntries?.(walk.path, walk.entries)
          const names = new Set(walk.entries.map((entry) => entry.name))
          const old = this.directories.get(walk.path)
          walk.previous = old
          if (old) {
            for (const path of old.files) {
              if (!names.has(relative(walk.path, path))) {
                this.forget(path)
              }
            }
            for (const child of old.children) {
              if (!names.has(relative(walk.path, child))) {
                this.directories.removeTree(child, (path) => this.forget(path))
              }
            }
          }
          this.directories.set(walk.path, { files: new Set(), children: new Set() })
          this.failures.delete(walk.path)
        } catch (error) {
          throwIfAiVaultScanCancelled(args.signal)
          this.issue(walk.path, error, args)
          this.walks.pop()
          this.scheduled.delete(walk.path)
          continue
        }
      }
      let batch = 0
      const node = this.directories.get(walk.path)!
      while (walk.offset < walk.entries.length && batch++ < 16) {
        const entry = walk.entries[walk.offset]
        const path = join(walk.path, entry.name)
        if (entry.isDirectory() && (args.directoryPredicate?.(entry.name, walk.depth) ?? true)) {
          node.children.add(path)
          if (walk.reconcile || !walk.previous?.children.has(path)) {
            this.schedule(path, walk.reconcile)
          }
        } else if (entry.isFile() && this.accepts(path, args)) {
          node.files.add(path)
          // Do not advance past an aborted observation.
          if (walk.reconcile || !walk.previous?.files.has(path)) {
            await this.observe(path, args, false, recentLimit)
          }
        }
        walk.offset++
      }
      consumed++
      if (walk.offset === walk.entries.length) {
        // Children may have been pushed above this frame.
        this.walks.splice(this.walks.indexOf(walk), 1)
        this.scheduled.delete(walk.path)
        if (this.trailing.delete(walk.path)) {
          this.schedule(walk.path)
        }
      }
    }
    if (!this.walks.length && this.reconcileAgain) {
      this.reconcileAgain = false
      this.schedule(this.root, true)
    }
    const changes = [...this.changes.values()]
    const removed = [...this.removed]
    this.changes.clear()
    this.removed.clear()
    return { changes, removed }
  }

  retryFailures(): void {
    for (const path of this.failures) {
      this.schedule(path)
    }
  }

  private accepts(path: string, args: DiscoverSessionFilesArgs): boolean {
    return isInsideSessionRoot(this.root, path) && isDiscoverableSessionFile(args, this.root, path)
  }

  private async observe(
    path: string,
    args: DiscoverSessionFilesArgs,
    force: boolean,
    limit: number
  ) {
    const observation = await observeSessionFile(
      path,
      !force && this.dependencyByFile.has(path)
        ? () => this.dependencyByFile.get(path)
        : args.contentDependencyPath,
      args.signal
    )
    throwIfAiVaultScanCancelled(args.signal)
    if ('issue' in observation) {
      if (!observation.missing) {
        recordSessionScanIssue(args.issues, { agent: args.agent, ...observation.issue })
      }
      // Only a successful parent listing removes membership; an unreadable stat is never deletion proof.
      if (this.files.has(path)) {
        this.schedule(dirname(path))
      }
      return
    }
    const file = {
      ...observation.file,
      modifiedAt: new Date(observation.file.mtimeMs).toISOString()
    }
    const old = this.files.get(path)
    const dependency = observation.sidecarPath
    const previous = this.dependencyByFile.get(path)
    if (previous !== dependency) {
      if (previous) {
        this.dependencies.get(previous)?.delete(path)
      }
      if (dependency) {
        const owners = this.dependencies.get(dependency) ?? new Set<string>()
        owners.add(path)
        this.dependencies.set(dependency, owners)
        this.dependencyByFile.set(path, dependency)
      } else {
        this.dependencyByFile.delete(path)
      }
    }
    const dependencyChanged =
      !!old &&
      file.sidecar !== 'unknown' &&
      !sidecarUnchanged(old.sidecar ?? 'none', file.sidecar ?? 'none')
    this.files.set(path, file)
    if (!old) {
      this.directories.addFile(path)
    }
    if (
      force ||
      !old ||
      dependencyChanged ||
      old.mtimeMs !== file.mtimeMs ||
      old.sizeBytes !== file.sizeBytes ||
      old.dev !== file.dev ||
      old.ino !== file.ino
    ) {
      this.changes.set(path, {
        file,
        force:
          dependencyChanged ||
          (force &&
            !!old &&
            old.mtimeMs === file.mtimeMs &&
            old.sizeBytes === file.sizeBytes &&
            old.dev === file.dev &&
            old.ino === file.ino)
      })
    }
    retainRecentSessionFile(this.recent, file, limit)
  }

  private forget(path: string): void {
    this.files.delete(path)
    this.recent.delete(path)
    const dependency = this.dependencyByFile.get(path)
    if (dependency) {
      this.dependencies.get(dependency)?.delete(path)
    }
    this.dependencyByFile.delete(path)
    this.changes.delete(path)
    this.removed.add(path)
  }

  private issue(path: string, error: unknown, args: DiscoverSessionFilesArgs) {
    this.failures.add(path)
    recordSessionScanIssue(args.issues, {
      agent: args.agent,
      path,
      ...scanIssueTextFromError(error)
    })
  }
}
