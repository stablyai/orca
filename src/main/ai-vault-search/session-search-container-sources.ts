import type {
  SessionSearchContainerAuthority,
  SessionSearchContainerOmission
} from './session-search-container-transition'
import { SessionSearchOperationError } from './session-search-worker-client'
import type { SessionSearchCatalogClient } from './session-search-catalog-client'
import {
  recordSessionSearchCatalogCounts,
  type SessionSearchCatalogRequest
} from './session-search-catalog-client'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import { SessionObservationRetries } from '../ai-vault/session-observation-retries'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { FileWithMtime, SessionFileDiscovery } from '../ai-vault/session-scanner-types'

export type SessionSearchContainerPhysical = {
  files: SessionSearchCatalogClient<{
    file: FileWithMtime
    epoch: number
    changed: boolean
    revision: number
  }>
  omissions: SessionSearchCatalogClient<SessionSearchContainerOmission>
  authority?: SessionSearchContainerAuthority
  epoch: number
  pending: number
  proof?: number
  signature?: string
  identity?: string
  fullDue: boolean
  retiring?: boolean
  retirement?: { authority: number; phase: 'raw' | 'receipts'; after?: string }
}
export type SessionSearchContainerFamily = {
  discovery?: SessionFileDiscovery
  physical: Map<string, SessionSearchContainerPhysical>
  sourceOrder: ReadonlyMap<string, number>
}

/** Recent observations add facts; only a successful exhaustive observation can withdraw them. */
export class SessionSearchContainerSources {
  protected readonly pathLists = new Map<
    string,
    { paths: readonly string[]; complete: boolean; issues: AiVaultScanIssue[] }
  >()
  protected seenPathLists = new Set<string>()
  protected readonly families = new Map<string, SessionSearchContainerFamily>()
  protected seen = new Set<string>()
  protected recentLimit = 12
  protected readonly retries = new SessionObservationRetries()
  protected request: SessionSearchCatalogRequest | undefined
  protected readonly deliveries = new WeakMap<
    SessionFileDiscovery,
    { scope: string; receipts: { key: string; revision: number }[] }[]
  >()
  async acknowledge(discovery: SessionFileDiscovery): Promise<void> {
    for (const page of this.deliveries.get(discovery) ?? []) {
      await this.request!({ kind: 'container-ack', scope: page.scope, receipts: page.receipts })
    }
    this.deliveries.delete(discovery)
  }
  protected readonly acceptedProofs = new Map<string, SessionSearchContainerPhysical>()
  attach(request: SessionSearchCatalogRequest): void {
    this.request ??= async (command) => {
      const result = await request(command)
      recordSessionSearchCatalogCounts(this.request!, result)
      return result
    }
  }
  readonly proofs = async (
    container: string,
    id: string,
    agent?: string | null
  ): Promise<boolean | null> => {
    const physical =
      this.acceptedProofs.get(`${agent}:${container}`) ?? this.acceptedProofs.get(container)
    if (physical?.proof === undefined) {
      return null
    }
    let after: string | undefined
    do {
      const page = await physical.files.page({ group: id, after })
      if (page.rows.some(({ value }) => value.epoch === physical.proof)) {
        return true
      }
      after = page.after
    } while (after !== undefined)
    return false
  }

  begin(full: boolean, recentLimit: number): void {
    this.seen = new Set()
    this.seenPathLists = new Set()
    this.retries.begin(full)
    this.recentLimit = recentLimit
    if (full) {
      for (const family of this.families.values()) {
        for (const physical of family.physical.values()) {
          physical.fullDue = true
        }
      }
    }
  }
  get pending(): boolean {
    for (const [root, list] of this.pathLists) {
      if (!list.complete && !this.retries.heldOut(`paths:${root}`)) {
        return true
      }
    }
    for (const [key, family] of this.families) {
      if (this.retries.heldOut(`paths:${key.slice(key.indexOf(':') + 1)}`)) {
        continue
      }
      for (const [path, physical] of family.physical) {
        if (
          (physical.pending ||
            physical.fullDue ||
            (physical.authority?.state !== 'unknown' &&
              physical.authority &&
              (physical.retirement || physical.omissions.readySize))) &&
          !this.retries.heldOut(`${key}:${path}`)
        ) {
          return true
        }
      }
    }
    return false
  }
  async containerPaths(
    root: string,
    read: (issues: AiVaultScanIssue[]) => Promise<readonly string[]>,
    issues: AiVaultScanIssue[]
  ): Promise<{ paths: readonly string[]; complete: boolean }> {
    this.seenPathLists.add(root)
    const key = `paths:${root}`
    const previous = this.pathLists.get(root)
    if (!this.retries.mayAttempt(key)) {
      for (const issue of previous?.issues ?? []) {
        recordSessionScanIssue(issues, issue)
      }
      return previous ?? { paths: [], complete: false }
    }
    const ownIssues: AiVaultScanIssue[] = []
    const paths = await read(ownIssues)
    const complete = !ownIssues.some((issue) => issue.kind !== 'notice')
    const result = {
      paths: complete ? paths : [...new Set([...(previous?.paths ?? []), ...paths])],
      complete,
      issues: ownIssues
    }
    this.pathLists.set(root, result)
    issues.push(...ownIssues)
    if (complete) {
      this.retries.delete(key)
    } else {
      this.retries.fail(key)
    }
    return result
  }
  protected async setAuthority(
    key: string,
    path: string,
    physical: SessionSearchContainerPhysical,
    state: SessionSearchContainerAuthority['state'],
    epoch?: number,
    restart = false
  ): Promise<void> {
    const previous = physical.authority
    physical.authority = undefined
    this.acceptedProofs.delete(`${key.split(':', 1)[0]}:${path}`)
    const command = {
      kind: 'container-retire' as const,
      scope: physical.files.scope,
      agent: key.split(':', 1)[0],
      authority: state,
      epoch,
      restart,
      authorityRevision: previous?.revision
    }
    let result = await physical.files.transition(command)
    if (result.accepted === false && result.authority) {
      result = await physical.files.transition({
        ...command,
        authorityRevision: result.authority.revision
      })
    }
    if (!result.accepted || !result.authority) {
      throw new SessionSearchOperationError('Container authority was superseded')
    }
    physical.authority = result.authority
  }
}
