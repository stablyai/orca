import {
  SessionSearchCatalogClient,
  recordSessionSearchCatalogCounts,
  type SessionSearchCatalogRequest
} from '../ai-vault-search/session-search-catalog-client'
import { SessionSearchCatalogFrontier } from '../ai-vault-search/session-search-catalog-frontier'
import { SessionSearchCatalogRetries } from '../ai-vault-search/session-search-catalog-retries'
import { dirname, join, relative } from 'node:path'
import { wslGatedReaddir } from '../native-chat/wsl-transcript-fs-access'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import {
  isMissingTranscriptPathError,
  type DiscoverSessionFilesArgs
} from './session-scanner-discovery'
import { isDiscoverableSessionFile, isInsideSessionRoot } from './session-file-discovery'
import { recordSessionScanIssue, scanIssueTextFromError } from './session-scan-issues'
import { SessionInventoryFiles } from './session-file-inventory-files'

type Walk = {
  path: string
  depth: number
  reconcile: boolean
  phase: 'load' | 'files' | 'children' | 'entries' | 'remove-files' | 'remove-children'
  after?: string
}
type Entry = { directory: boolean; file: boolean }

/** Directory epochs stage one input at a time and retain only their cursor in the scanner. */
export class SessionInventoryDirectoryWalks {
  protected readonly observations: SessionInventoryFiles
  protected readonly directories: SessionSearchCatalogClient<true>
  protected readonly entries: SessionSearchCatalogClient<Entry>
  protected readonly dirty: SessionSearchCatalogFrontier<boolean>
  protected readonly walks: SessionSearchCatalogFrontier<Walk>
  protected readonly trailing: SessionSearchCatalogClient<true>
  protected readonly failures: SessionSearchCatalogRetries
  protected readonly removedDirectories = new Set<string>()
  protected readonly request: SessionSearchCatalogRequest
  constructor(
    readonly root: string,
    request: SessionSearchCatalogRequest,
    readonly scope: string
  ) {
    this.request = async (command) => {
      const result = await request(command)
      recordSessionSearchCatalogCounts(this.request, result)
      return result
    }
    this.directories = new SessionSearchCatalogClient(`${scope}:directories`, this.request)
    this.entries = new SessionSearchCatalogClient(`${scope}:directory-input`, this.request)
    this.trailing = new SessionSearchCatalogClient(`${scope}:trailing`, this.request)
    this.dirty = new SessionSearchCatalogFrontier(
      new SessionSearchCatalogClient(`${scope}:dirty`, this.request)
    )
    this.walks = new SessionSearchCatalogFrontier(
      new SessionSearchCatalogClient(`${scope}:walks`, this.request)
    )
    this.failures = new SessionSearchCatalogRetries(
      new SessionSearchCatalogClient(`${scope}:refusals`, this.request)
    )
    this.observations = new SessionInventoryFiles(scope, this.request, (path) =>
      this.schedule(path)
    )
  }
  protected async addDirectory(path: string): Promise<void> {
    let child = path
    while (isInsideSessionRoot(this.root, child)) {
      if (await this.directories.get(child)) {
        return
      }
      await this.directories.put(child, true, { parent: dirname(child) })
      if (child === this.root) {
        return
      }
      child = dirname(child)
    }
  }
  protected async schedule(path: string, reconcile = false, remove = false): Promise<void> {
    if (!isInsideSessionRoot(this.root, path)) {
      return
    }
    if (remove) {
      await this.walks.cancelTree(path)
      await this.dirty.cancelTree(path)
      await this.trailing.releasePrefix(path)
    } else if (await this.walks.has(path)) {
      return
    }
    await this.addDirectory(path)
    const rel = relative(this.root, path)
    await this.walks.set(path, {
      path,
      depth: rel ? rel.split(/[\\/]/).length : 0,
      reconcile,
      phase: remove ? 'remove-files' : 'load'
    })
  }
  protected async drainWalk(
    walk: Walk,
    args: DiscoverSessionFilesArgs,
    limit: number
  ): Promise<void> {
    if (walk.phase === 'load') {
      if (!(await this.failures.mayAttempt(walk.path))) {
        await this.walks.delete(walk.path)
        return
      }
      try {
        await this.request({ kind: 'release-parent', scope: this.entries.scope, parent: walk.path })
        const entries = await wslGatedReaddir(walk.path, 'scan', args.signal)
        args.onDirectoryEntries?.(walk.path, entries)
        // The filesystem returns one indivisible directory; release it before loading another.
        for (let offset = 0; offset < entries.length; offset += 256) {
          await this.entries.putPage(
            entries.slice(offset, offset + 256).map((entry) =>
              this.entries.encode(
                join(walk.path, entry.name),
                {
                  directory:
                    entry.isDirectory() &&
                    (args.directoryPredicate?.(entry.name, walk.depth) ?? true),
                  file: entry.isFile() && this.accepts(join(walk.path, entry.name), args)
                },
                { parent: walk.path }
              )
            )
          )
        }
        await this.failures.delete(walk.path)
        walk.phase = 'files'
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        if (isMissingTranscriptPathError(error)) {
          await this.failures.delete(walk.path)
          walk.phase = 'remove-files'
        } else {
          await this.issue(walk.path, error, args)
          await this.walks.delete(walk.path)
          return
        }
      }
    }
    const page = await this.request({
      kind: 'directory-step',
      scope: this.scope,
      path: walk.path,
      phase: walk.phase,
      after: walk.after,
      reconcile: walk.reconcile
    })
    walk.after = page.after
    for (const path of page.removedFiles ?? []) {
      this.observations.recordRemoval(path)
    }
    if (walk.phase === 'files' || walk.phase === 'remove-files') {
      if (!walk.after) {
        walk.phase = walk.phase === 'files' ? 'children' : 'remove-children'
      }
    } else if (walk.phase === 'children' || walk.phase === 'remove-children') {
      for (const entry of page.directoryPage ?? []) {
        await this.schedule(entry.key, false, true)
      }
      if (!walk.after) {
        if (walk.phase === 'remove-children') {
          await this.directories.delete(walk.path)
          this.removedDirectories.add(walk.path)
          await this.finishWalk(walk.path)
          return
        }
        walk.phase = 'entries'
      }
    } else {
      const files: { path: string; force: boolean }[] = []
      for (const entry of page.directoryPage ?? []) {
        if (entry.directory) {
          await this.schedule(entry.key, walk.reconcile)
        } else {
          files.push({ path: entry.key, force: false })
        }
      }
      await this.observations.observePage(files, args, limit)
      if (!walk.after) {
        await this.finishWalk(walk.path)
        return
      }
    }
    await this.walks.set(walk.path, walk)
  }
  protected async finishWalk(path: string): Promise<void> {
    await this.walks.delete(path)
    if (await this.trailing.get(path)) {
      await this.trailing.delete(path)
      await this.schedule(path)
    }
  }
  protected accepts(path: string, args: DiscoverSessionFilesArgs): boolean {
    return isInsideSessionRoot(this.root, path) && isDiscoverableSessionFile(args, this.root, path)
  }
  protected async issue(
    path: string,
    error: unknown,
    args: DiscoverSessionFilesArgs
  ): Promise<void> {
    const issue = { agent: args.agent, path, ...scanIssueTextFromError(error) }
    await this.addDirectory(path)
    await this.failures.fail(path, false, issue)
    recordSessionScanIssue(args.issues, issue)
  }
}
