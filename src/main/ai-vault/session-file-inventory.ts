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
  type DiscoverSessionFilesArgs
} from './session-scanner-discovery'
import { isDiscoverableSessionFile, isInsideSessionRoot } from './session-file-discovery'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import { SessionInventoryFiles, type SessionFileChange } from './session-file-inventory-files'

export type { SessionFileChange } from './session-file-inventory-files'
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
  private readonly observations: SessionInventoryFiles
  get files() {
    return this.observations.files
  }
  get dependencies() {
    return this.observations.dependencies
  }
  private readonly directories: SessionInventoryDirectories
  private readonly dirty = new Map<string, boolean>()
  private readonly walks: Walk[] = []
  private readonly scheduled = new Set<string>()
  private readonly trailing = new Set<string>()
  private readonly failures = new Set<string>()
  private reconcileAgain = false
  private reconciling = false
  private chooseDirty = true
  private readonly removedDirectories = new Set<string>()

  constructor(readonly root: string) {
    this.directories = new SessionInventoryDirectories(root)
    this.observations = new SessionInventoryFiles(
      (path) => this.directories.addFile(path),
      (path) => this.schedule(dirname(path)),
      (path) => this.dirty.delete(path)
    )
    this.reconcile()
  }

  get pending(): boolean {
    return (
      this.walks.length > 0 ||
      this.dirty.size > 0 ||
      this.reconcileAgain ||
      this.failures.size > 0 ||
      this.observations.failures.size > 0
    )
  }

  get walking(): boolean {
    return this.walks.length > 0 || this.reconcileAgain
  }

  reconcile(): void {
    // A burst during a crawl leaves one trailing obligation, never restarts its prefix.
    if (this.reconciling) {
      this.reconcileAgain = true
      return
    }
    this.reconciling = true
    this.schedule(this.root, true)
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
    if (!isInsideSessionRoot(this.root, path) || this.scheduled.has(path)) {
      return
    }
    const rel = relative(this.root, path)
    this.walks.push({ path, depth: rel ? rel.split(/[\\/]/).length : 0, offset: 0, reconcile })
    this.scheduled.add(path)
  }

  async pollRecent(args: DiscoverSessionFilesArgs, limit: number): Promise<void> {
    // This set is bounded on admission; never project/sort the archive to find recent paths.
    const paths = [...this.observations.recent.keys()]
    for (const path of paths) {
      if (!this.dirty.has(path)) {
        await this.observations.observe(path, args, false, limit)
      }
    }
  }

  async drain(
    args: DiscoverSessionFilesArgs,
    overdue: () => boolean,
    recentLimit: number
  ): Promise<{ changes: SessionFileChange[]; removed: string[]; removedDirectories: string[] }> {
    let consumed = 0
    while ((this.dirty.size || this.walks.length) && (consumed === 0 || !overdue())) {
      if (this.dirty.size && (!this.walks.length || this.chooseDirty)) {
        this.chooseDirty = false
        await this.drainDirty(args, recentLimit)
        consumed++
        continue
      }
      this.chooseDirty = true
      throwIfAiVaultScanCancelled(args.signal)
      const walk = this.walks[0]
      if (!walk.entries) {
        try {
          walk.entries = await wslGatedReaddir(walk.path, 'scan', args.signal)
          args.onDirectoryEntries?.(walk.path, walk.entries)
          const entries = new Map(walk.entries.map((entry) => [entry.name, entry]))
          const old = this.directories.get(walk.path)
          walk.previous = old
          if (old) {
            for (const path of old.files) {
              if (!entries.get(relative(walk.path, path))?.isFile()) {
                this.observations.forget(path)
                old.files.delete(path)
              }
            }
            for (const child of old.children) {
              if (!entries.get(relative(walk.path, child))?.isDirectory()) {
                this.removeDirectory(child)
              }
            }
          }
          this.directories.set(walk.path, old ?? { files: new Set(), children: new Set() })
          this.failures.delete(walk.path)
        } catch (error) {
          throwIfAiVaultScanCancelled(args.signal)
          if (isMissingTranscriptPathError(error)) {
            this.failures.delete(walk.path)
            this.removeDirectory(walk.path)
          } else {
            this.issue(walk.path, error, args)
          }
          const index = this.walks.indexOf(walk)
          if (index !== -1) {
            this.walks.splice(index, 1)
          }
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
          const known = walk.previous?.children.has(path)
          node.children.add(path)
          if (walk.reconcile || !known) {
            this.schedule(path, walk.reconcile)
          }
        } else if (entry.isFile() && this.accepts(path, args)) {
          const known = walk.previous?.files.has(path)
          node.files.add(path)
          // Do not advance past an aborted observation.
          if (walk.reconcile || !known) {
            await this.observations.observe(path, args, false, recentLimit)
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
    if (!this.walks.length) {
      this.reconciling = false
      if (this.reconcileAgain) {
        this.reconcileAgain = false
        this.reconcile()
      }
    }
    const changes = [...this.observations.changes.values()]
    const removed = [...this.observations.removed]
    this.observations.changes.clear()
    this.observations.removed.clear()
    const removedDirectories = [...this.removedDirectories]
    this.removedDirectories.clear()
    return { changes, removed, removedDirectories }
  }

  private async drainDirty(args: DiscoverSessionFilesArgs, recentLimit: number): Promise<void> {
    const first = this.dirty.entries().next().value
    if (!first) {
      return
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
      await this.observations.observe(path, args, force, recentLimit)
    } else if (isInsideSessionRoot(this.root, path)) {
      try {
        const stat = await wslGatedStat(path, 'scan', args.signal)
        this.failures.delete(path)
        if (stat.isDirectory()) {
          if (!isInsideSessionRoot(this.root, path) || this.scheduled.has(path)) {
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
          this.removeDirectory(path)
          this.schedule(dirname(path))
        } else {
          this.issue(path, error, args)
        }
      }
    }
  }

  private removeDirectory(path: string): void {
    for (let index = this.walks.length - 1; index >= 0; index--) {
      const walk = this.walks[index]
      if (isInsideSessionRoot(path, walk.path)) {
        this.walks.splice(index, 1)
        this.scheduled.delete(walk.path)
        this.trailing.delete(walk.path)
      }
    }
    for (const failed of this.failures) {
      if (isInsideSessionRoot(path, failed)) {
        this.failures.delete(failed)
      }
    }
    this.directories.get(dirname(path))?.children.delete(path)
    this.directories.removeTree(
      path,
      (file) => this.observations.forget(file),
      (directory) => {
        this.removedDirectories.add(directory)
      }
    )
  }

  retryFailures(): void {
    for (const path of this.failures) {
      this.schedule(path, true)
    }
    for (const [path, force] of this.observations.failures) {
      this.invalidate(path, force)
    }
  }

  private accepts(path: string, args: DiscoverSessionFilesArgs): boolean {
    return isInsideSessionRoot(this.root, path) && isDiscoverableSessionFile(args, this.root, path)
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
