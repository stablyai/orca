import type {
  SessionSearchPreparedObservation,
  SessionSearchObservationOutcome,
  SessionSearchObservationInput
} from '../ai-vault-search/session-search-inventory-transition'
import { sessionSearchRecordPages } from '../ai-vault-search/session-search-catalog-pages'
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

type ReadableObservation = {
  file: FileWithMtime
  delivery?: { revision: number; force: boolean; metadata?: boolean }
}

export type SessionFileChange = { file: FileWithMtime; force: boolean; metadata?: boolean }

/** Accepted file facts and retry debt survive both directory epochs and delivered events. */
export class SessionInventoryFiles {
  readonly files: SessionSearchCatalogClient<{
    file: Omit<FileWithMtime, 'modifiedAt'>
    dependency?: string
  }>
  readonly delivery: SessionSearchCatalogClient<{
    file?: Omit<FileWithMtime, 'modifiedAt'>
    force: boolean
    metadata?: boolean
    removed?: boolean
    revision: number
    authority?: number
  }>
  readonly failures: SessionSearchCatalogRetries
  get count(): number {
    return this.files.size
  }
  readonly changes = new Map<string, SessionFileChange>()
  readonly removed = new Set<string>()
  readonly handoffs = new Map<string, number>()
  private pending: { outcomes: SessionSearchObservationOutcome[]; generation: number } | undefined
  readonly recent = new Map<string, FileWithMtime>()
  constructor(
    private readonly scope: string,
    request: SessionSearchCatalogRequest,
    private readonly scheduleParent: (path: string) => Promise<void>
  ) {
    this.delivery = new SessionSearchCatalogClient(`${scope}:delivery`, request)
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
    readOwed = false,
    metadataOwed = false,
    readContext?: Pick<SessionSearchObservationInput, 'requireMembership' | 'dependencyOwners'>
  ) {
    return (
      await this.observePage([{ path, force, readOwed, metadataOwed, ...readContext }], args, limit)
    ).get(path)
  }
  async observePage(
    inputs: SessionSearchObservationInput[],
    args: DiscoverSessionFilesArgs,
    limit: number
  ): Promise<Map<string, ReadableObservation>> {
    this.handoffs.clear()
    const readable = await this.resume(limit)
    for (const page of sessionSearchRecordPages(inputs)) {
      let offset = 0
      while (offset < page.length) {
        const prepared = await this.files.transition({
          kind: 'observe-prepare',
          scope: this.scope,
          generation: this.failures.epoch,
          inputs: page.slice(offset)
        })
        const projected = prepared.prepared ?? []
        if (!projected.length) {
          throw new Error('Session observation did not advance')
        }
        for (const [path, file] of await this.observePrepared(projected, args, limit)) {
          readable.set(path, file)
        }
        offset += projected.length
      }
    }
    return readable
  }
  private async observePrepared(
    prepared: SessionSearchPreparedObservation[],
    args: DiscoverSessionFilesArgs,
    limit: number
  ): Promise<Map<string, ReadableObservation>> {
    const outcomes: SessionSearchObservationOutcome[] = []
    for (const input of prepared) {
      if (!input.attempt) {
        if (input.refusalRevision !== undefined) {
          this.handoffs.set(input.path, input.refusalRevision)
        }
        continue
      }
      const previous = input.accepted
        ? {
            ...input.accepted.file,
            modifiedAt: new Date(input.accepted.file.mtimeMs).toISOString()
          }
        : undefined
      const observation = await observeSessionFile(
        input.path,
        args.contentDependencyPath,
        args.signal,
        !input.force && previous ? { file: previous, path: input.accepted?.dependency } : undefined
      )
      throwIfAiVaultScanCancelled(args.signal)
      if ('issue' in observation) {
        const issue = observation.missing ? undefined : { agent: args.agent, ...observation.issue }
        if (issue) {
          recordSessionScanIssue(args.issues, issue)
        }
        outcomes.push({ ...input, missing: observation.missing, issue })
      } else {
        const file = {
          ...observation.file,
          modifiedAt: new Date(observation.file.mtimeMs).toISOString()
        }
        const metadataOnly = sidecarEnrichesWithoutReparse({
          agent: args.agent,
          file,
          codexHome: null
        })
        outcomes.push({
          ...input,
          observed: { file: observation.file, dependency: observation.sidecarPath },
          metadataOnly
        })
      }
    }
    this.pending = { outcomes, generation: this.failures.epoch }
    return this.resume(limit)
  }
  get applying(): boolean {
    return !!this.pending
  }
  async resume(limit: number): Promise<Map<string, ReadableObservation>> {
    const readable = new Map<string, ReadableObservation>()
    while (this.pending?.outcomes.length) {
      const page = sessionSearchRecordPages(this.pending.outcomes).next().value!
      const accepted = await this.files.transition({
        kind: 'observe-apply',
        scope: this.scope,
        generation: this.pending.generation,
        outcomes: page
      })
      this.pending.outcomes.splice(0, page.length)
      for (const refusal of accepted.refusals ?? []) {
        this.handoffs.set(refusal.path, refusal.revision)
      }
      for (const path of accepted.missingParents ?? []) {
        await this.scheduleParent(path)
      }
      for (const observation of accepted.observations ?? []) {
        const file = observation.file!
        if (observation.changed) {
          this.changes.set(observation.path, {
            file,
            force: observation.force,
            metadata: observation.metadata
          })
        }
        retainRecentSessionFile(this.recent, file, limit)
        if (observation.readable) {
          readable.set(observation.path, { file, delivery: observation.delivery })
        }
      }
    }
    this.pending = undefined
    return readable
  }
  recordRemoval(path: string): void {
    this.recent.delete(path)
    this.changes.delete(path)
    this.removed.add(path)
  }
  async forget(path: string): Promise<void> {
    await this.forgetPage([path])
  }
  async forgetPage(paths: string[]): Promise<void> {
    await this.files.transition({ kind: 'forget-files', scope: this.scope, paths })
    for (const path of paths) {
      this.recordRemoval(path)
    }
  }

  async acknowledge(receipts: { path: string; revision: number }[]): Promise<void> {
    if (!receipts.length) {
      return
    }
    await this.files.transition({ kind: 'observe-ack', scope: this.scope, receipts })
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
