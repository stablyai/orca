import { dirname } from 'node:path'
import {
  SessionSearchCatalogClient,
  type SessionSearchCatalogRequest
} from '../ai-vault-search/session-search-catalog-client'
import { SessionSearchCatalogRetries } from '../ai-vault-search/session-search-catalog-retries'
import type { FileWithMtime } from './session-scanner-types'
import { observeSessionFile, type DiscoverSessionFilesArgs } from './session-scanner-discovery'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { recordSessionScanIssue } from './session-scan-issues'
import { retainRecentSessionFile } from './session-file-observation'
import { sidecarEnrichesWithoutReparse } from './parse-cache/session-scanner-sidecar-enrichment'
import { sidecarUnchanged } from './parse-cache/session-sidecar-stat'

export type SessionFileChange = { file: FileWithMtime; force: boolean }

/** Accepted file facts and retry debt survive both directory epochs and delivered events. */
export class SessionInventoryFiles {
  readonly files: SessionSearchCatalogClient<{
    file: Omit<FileWithMtime, 'modifiedAt'>
    dependency?: string
  }>
  readonly failures: SessionSearchCatalogRetries
  count = 0
  readonly changes = new Map<string, SessionFileChange>()
  readonly removed = new Set<string>()
  readonly recent = new Map<string, FileWithMtime>()
  constructor(
    scope: string,
    request: SessionSearchCatalogRequest,
    private readonly addFile: (path: string) => Promise<void>,
    private readonly scheduleParent: (path: string) => Promise<void>,
    private readonly forgetDirty: (path: string) => Promise<void>
  ) {
    this.files = new SessionSearchCatalogClient(`${scope}:files`, request)
    this.failures = new SessionSearchCatalogRetries(
      new SessionSearchCatalogClient(`${scope}:file-refusals`, request)
    )
  }
  async observe(
    path: string,
    args: DiscoverSessionFilesArgs,
    force: boolean,
    limit: number,
    readOwed = false
  ) {
    if (!(await this.failures.mayAttempt(path))) {
      if (force || readOwed) {
        await this.failures.requireRead(path)
      }
      return
    }
    force ||= await this.failures.force(path)
    const accepted = await this.files.get(path)
    const previous = accepted
      ? { ...accepted.file, modifiedAt: new Date(accepted.file.mtimeMs).toISOString() }
      : undefined
    const observation = await observeSessionFile(
      path,
      args.contentDependencyPath,
      args.signal,
      !force && previous ? { file: previous, path: accepted?.dependency } : undefined
    )
    throwIfAiVaultScanCancelled(args.signal)
    if ('issue' in observation) {
      if (observation.missing && !accepted) {
        await this.failures.delete(path)
        return
      }
      if (!observation.missing) {
        recordSessionScanIssue(args.issues, { agent: args.agent, ...observation.issue })
      }
      await this.failures.fail(
        path,
        force || readOwed,
        observation.missing ? undefined : { agent: args.agent, ...observation.issue }
      )
      // Only apparent absence needs a parent membership proof.
      if (observation.missing) {
        await this.scheduleParent(path)
      }
      return
    }
    const file = {
      ...observation.file,
      modifiedAt: new Date(observation.file.mtimeMs).toISOString()
    }
    const metadataOnly = sidecarEnrichesWithoutReparse({
      agent: args.agent,
      file,
      codexHome: null
    })
    if (!metadataOnly && observation.file.sidecar === 'unknown') {
      await this.failures.fail(path, force || readOwed)
      file.sidecar = previous?.sidecar ?? 'unknown'
    } else {
      await this.failures.delete(path)
    }
    const old = previous
    const dependency = metadataOnly ? undefined : observation.sidecarPath
    const dependencyChanged =
      !metadataOnly &&
      !!old &&
      file.sidecar !== 'unknown' &&
      !sidecarUnchanged(old.sidecar ?? 'none', file.sidecar ?? 'none')
    const { modifiedAt: _modifiedAt, ...facts } = file
    await this.files.put(
      path,
      { file: facts, dependency },
      { parent: dirname(path), group: dependency }
    )
    if (!old) {
      this.count++
      await this.addFile(path)
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
    return !metadataOnly && observation.file.sidecar === 'unknown' ? undefined : file
  }

  async forget(path: string): Promise<void> {
    if (await this.files.get(path)) {
      await this.files.delete(path)
      this.count--
    }
    await this.failures.delete(path)
    await this.forgetDirty(path)
    this.recent.delete(path)
    this.changes.delete(path)
    this.removed.add(path)
  }

  async *owners(dependency: string): AsyncGenerator<string> {
    let after: string | undefined
    do {
      const page = await this.files.page({ after, group: dependency })
      for (const { key } of page.rows) {
        yield key
      }
      after = page.after
    } while (after !== undefined)
  }
}
