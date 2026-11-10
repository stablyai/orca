import {
  SessionSearchCatalogClient,
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
  constructor(
    readonly root: string,
    protected readonly request: SessionSearchCatalogRequest,
    readonly scope: string
  ) {
    this.directories = new SessionSearchCatalogClient(`${scope}:directories`, request)
    this.entries = new SessionSearchCatalogClient(`${scope}:directory-input`, request)
    this.trailing = new SessionSearchCatalogClient(`${scope}:trailing`, request)
    this.dirty = new SessionSearchCatalogFrontier(
      new SessionSearchCatalogClient(`${scope}:dirty`, request)
    )
    this.walks = new SessionSearchCatalogFrontier(
      new SessionSearchCatalogClient(`${scope}:walks`, request)
    )
    this.failures = new SessionSearchCatalogRetries(
      new SessionSearchCatalogClient(`${scope}:refusals`, request)
    )
    this.observations = new SessionInventoryFiles(
      scope,
      request,
      (path) => this.addDirectory(dirname(path)),
      (path) => this.schedule(dirname(path)),
      (path) => this.dirty.delete(path)
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
        let after: string | undefined
        do {
          const page = await this.entries.page({ parent: walk.path, after })
          for (const { key } of page.rows) {
            await this.entries.delete(key)
          }
          after = page.after
        } while (after !== undefined)
        const entries = await wslGatedReaddir(walk.path, 'scan', args.signal)
        args.onDirectoryEntries?.(walk.path, entries)
        // The filesystem returns one indivisible directory; release it before loading another.
        for (let offset = 0; offset < entries.length; offset += 256) {
          await this.entries.putPage(
            entries.slice(offset, offset + 256).map((entry) =>
              this.entries.encode(
                join(walk.path, entry.name),
                {
                  directory: entry.isDirectory(),
                  file: entry.isFile()
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
    if (walk.phase === 'files' || walk.phase === 'remove-files') {
      const page = await this.observations.files.page({
        parent: walk.path,
        after: walk.after,
        limit: 16
      })
      for (const { key } of page.rows) {
        if (walk.phase === 'remove-files' || !(await this.entries.get(key))?.file) {
          await this.observations.forget(key)
        }
      }
      walk.after = page.after
      if (!walk.after) {
        walk.phase = walk.phase === 'files' ? 'children' : 'remove-children'
      }
    } else if (walk.phase === 'children' || walk.phase === 'remove-children') {
      const page = await this.directories.page({ parent: walk.path, after: walk.after, limit: 16 })
      for (const { key } of page.rows) {
        if (walk.phase === 'remove-children' || !(await this.entries.get(key))?.directory) {
          await this.schedule(key, false, true)
        }
      }
      walk.after = page.after
      if (!walk.after) {
        if (walk.phase === 'remove-children') {
          await this.directories.delete(walk.path)
          this.removedDirectories.add(walk.path)
          await this.finishWalk(walk.path)
          return
        }
        walk.phase = 'entries'
      }
    } else if (walk.phase === 'entries') {
      const page = await this.entries.page({ parent: walk.path, after: walk.after, limit: 16 })
      for (const { key, value } of page.rows) {
        if (
          value.directory &&
          (args.directoryPredicate?.(relative(walk.path, key), walk.depth) ?? true)
        ) {
          const known = await this.directories.get(key)
          await this.addDirectory(key)
          if (walk.reconcile || !known) {
            await this.schedule(key, walk.reconcile)
          }
        } else if (value.file && this.accepts(key, args)) {
          if (walk.reconcile || !(await this.observations.files.get(key))) {
            await this.observations.observe(key, args, false, limit)
          }
        }
        await this.entries.delete(key)
      }
      walk.after = page.after
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
