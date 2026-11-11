import {
  SessionSearchCatalogClient,
  recordSessionSearchCatalogCounts,
  shareSessionSearchCatalogCounts,
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
import type { SessionSearchInputReceipt } from '../ai-vault-search/session-search-catalog-types'
import { SessionInventoryFiles } from './session-file-inventory-files'

type Walk = {
  path: string
  depth: number
  reconcile: boolean
  phase: 'load' | 'files' | 'children' | 'entries' | 'remove-files' | 'remove-children'
  after?: string
  epoch?: number
  cutoff?: number
  origin?: number
}
type Entry = { directory: boolean; file: boolean }

/** Directory epochs stage one input at a time and retain only their cursor in the scanner. */
export class SessionInventoryDirectoryWalks {
  protected readonly observations: SessionInventoryFiles
  protected readonly directories: SessionSearchCatalogClient<true>
  protected readonly entries: SessionSearchCatalogClient<Entry>
  protected readonly dirty: SessionSearchCatalogFrontier<boolean>
  protected readonly walks: SessionSearchCatalogFrontier<Walk>
  protected readonly cancellations: SessionSearchCatalogClient<unknown>
  protected readonly trailing: SessionSearchCatalogClient<true>
  protected readonly authority: SessionSearchCatalogClient<unknown>
  protected readonly primaryWakes: SessionSearchCatalogClient<unknown>
  protected readonly garbage: SessionSearchCatalogClient<unknown>
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
    shareSessionSearchCatalogCounts(this.request, request)
    this.authority = new SessionSearchCatalogClient(`${scope}:authority`, this.request)
    this.primaryWakes = new SessionSearchCatalogClient(`${scope}:primary-wakes`, this.request)
    this.garbage = new SessionSearchCatalogClient(`${scope}:authority-garbage`, this.request)
    this.directories = new SessionSearchCatalogClient(`${scope}:directories`, this.request)
    this.entries = new SessionSearchCatalogClient(`${scope}:directory-input`, this.request)
    this.cancellations = new SessionSearchCatalogClient(`${scope}:cancellations`, this.request)
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
  protected get hasMembership(): boolean {
    return (
      this.observations.count > 0 ||
      this.directories.size > 0 ||
      this.entries.size > 0 ||
      this.trailing.size > 0 ||
      ['observing', 'observation-epochs', 'dirty-expansion'].some(
        (suffix) => new SessionSearchCatalogClient(`${this.scope}:${suffix}`, this.request).size > 0
      )
    )
  }
  async has(path: string): Promise<boolean> {
    return (await this.observations.files.get(path)) !== undefined
  }
  hasPublicationDebt(path: string): Promise<boolean> {
    return this.observations.failures.force(path, this.scope)
  }
  get catalogRequest(): SessionSearchCatalogRequest {
    return this.request
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
  protected async schedule(
    path: string,
    reconcile = false,
    remove = false,
    cutoff?: number,
    receipt?: SessionSearchInputReceipt
  ): Promise<void> {
    if (!isInsideSessionRoot(this.root, path)) {
      return
    }
    const rel = relative(this.root, path)
    await this.request({
      kind: 'directory-schedule',
      scope: this.scope,
      path,
      depth: rel ? rel.split(/[\\/]/).length : 0,
      reconcile,
      remove,
      cutoff,
      receipt
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
        walk.epoch = (
          await this.request({ kind: 'directory-begin', scope: this.scope, path: walk.path })
        ).observationEpoch!
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
            ),
            { scope: this.scope, path: walk.path, epoch: walk.epoch }
          )
        }
        await this.request({
          kind: 'directory-seal',
          scope: this.scope,
          path: walk.path,
          epoch: walk.epoch
        })
        await this.failures.delete(walk.path)
        walk.phase = 'files'
      } catch (error) {
        throwIfAiVaultScanCancelled(args.signal)
        if (isMissingTranscriptPathError(error)) {
          await this.failures.delete(walk.path)
          await this.request({
            kind: 'directory-seal',
            scope: this.scope,
            path: walk.path,
            epoch: walk.epoch!
          })
          walk.phase = 'remove-files'
        } else {
          await this.issue(walk.path, error, args)
          await this.finishWalk(walk.path, walk.epoch)
          return
        }
      }
    }
    if (walk.epoch === undefined) {
      walk.epoch = (
        await this.request({
          kind: 'directory-begin',
          scope: this.scope,
          path: walk.path,
          cutoff: walk.cutoff
        })
      ).observationEpoch!
    }
    const page = await this.request({
      kind: 'directory-step',
      epoch: walk.epoch,
      scope: this.scope,
      path: walk.path,
      phase: walk.phase,
      after: walk.after,
      reconcile: walk.reconcile,
      depth: walk.depth
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
      if (!walk.after) {
        if (walk.phase === 'remove-children') {
          const removed = await this.finishWalk(walk.path, walk.epoch, true)
          if (removed) {
            this.removedDirectories.add(walk.path)
          }
          return
        }
        walk.phase = 'entries'
      }
    } else {
      const files: { path: string; force: boolean }[] = []
      for (const entry of page.directoryPage ?? []) {
        files.push({ path: entry.key, force: false })
      }
      await this.observations.observePage(files, args, limit)
      if (!walk.after) {
        await this.finishWalk(walk.path, walk.epoch)
        return
      }
    }
    await this.walks.set(walk.path, walk)
  }
  protected async finishWalk(path: string, epoch?: number, remove = false): Promise<boolean> {
    const result =
      epoch === undefined
        ? undefined
        : await this.request({ kind: 'directory-end', scope: this.scope, path, epoch, remove })
    await this.walks.delete(path)
    if (remove && !result?.directoryProtected) {
      await this.failures.delete(path)
    }
    if (result?.directoryProtected || (await this.trailing.get(path))) {
      await this.trailing.delete(path)
      await this.schedule(path)
    }
    return !result?.directoryProtected
  }
  protected accepts(path: string, args: DiscoverSessionFilesArgs): boolean {
    return isInsideSessionRoot(this.root, path) && isDiscoverableSessionFile(args, this.root, path)
  }
  protected async issue(
    path: string,
    error: unknown,
    args: DiscoverSessionFilesArgs,
    attempt?: { generation: number; receipt: SessionSearchInputReceipt }
  ): Promise<void> {
    const issue = { agent: args.agent, path, ...scanIssueTextFromError(error) }
    await this.addDirectory(path)
    await this.failures.fail(path, false, issue, attempt)
    recordSessionScanIssue(args.issues, issue)
  }
}
