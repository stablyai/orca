import type {
  SessionSearchContainerAuthority,
  SessionSearchContainerRemoval,
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
type Family = {
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
  protected readonly families = new Map<string, Family>()
  protected seen = new Set<string>()
  protected recentLimit = 12
  protected readonly retries = new SessionObservationRetries()
  readonly removed = new Map<string, Set<string>>()
  protected request: SessionSearchCatalogRequest | undefined
  readonly removalReceipts = new Map<string, SessionSearchContainerRemoval[]>()
  private readonly deliveredScopes = new Set<string>()
  private retirementRows = 0
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
  async acknowledgeRetirements(): Promise<void> {
    for (const scope of this.deliveredScopes) {
      await this.request!({ kind: 'count', scope: `${scope}:omissions` })
    }
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
    this.removed.clear()
    this.removalReceipts.clear()
    this.deliveredScopes.clear()
    this.retirementRows = 0
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
  protected async drainRetirements(): Promise<void> {
    for (const family of this.families.values()) {
      for (const physical of family.physical.values()) {
        if (
          !physical.authority ||
          physical.authority.state === 'unknown' ||
          !physical.omissions.readySize ||
          this.deliveredScopes.has(physical.files.scope) ||
          this.retirementRows >= 256
        ) {
          continue
        }
        this.deliveredScopes.add(physical.files.scope)
        const page = await physical.omissions.page({ ready: 1, limit: 256 - this.retirementRows })
        for (const { key: path, value } of page.rows) {
          if (
            value.authority !== physical.authority.revision ||
            value.incarnation !== physical.authority.incarnation
          ) {
            continue
          }
          const agents = this.removed.get(path) ?? new Set<string>()
          agents.add(value.agent)
          this.removed.set(path, agents)
          const receipts = this.removalReceipts.get(path) ?? []
          receipts.push({ ...value, scope: physical.files.scope })
          this.removalReceipts.set(path, receipts)
          this.retirementRows++
        }
      }
    }
  }
  protected async release(
    key: string,
    path: string,
    family: Family,
    physical: SessionSearchContainerPhysical
  ): Promise<void> {
    if (!physical.retiring || physical.authority?.state !== 'released') {
      await this.setAuthority(key, path, physical, 'released')
      physical.retiring = true
      physical.fullDue = false
      physical.retirement = { authority: physical.authority!.revision, phase: 'raw' }
    }
    await this.advanceRetirement(key, family, physical)
    this.retries.delete(`${key}:${path}`)
    this.acceptedProofs.delete(`${key.split(':', 1)[0]}:${path}`)
    if (!physical.retirement && !physical.omissions.size && !physical.files.size) {
      await physical.files.transition({
        kind: 'release',
        scope: `${physical.files.scope}:authority`
      })
      family.physical.delete(path)
    }
  }
  protected async advanceRetirement(
    key: string,
    family: Family,
    physical: SessionSearchContainerPhysical
  ): Promise<void> {
    const retirement = physical.retirement
    if (
      !retirement ||
      physical.authority?.state === 'unknown' ||
      physical.authority?.revision !== retirement.authority
    ) {
      return
    }
    const result = await physical.files.transition({
      kind: 'container-retire',
      scope: physical.files.scope,
      authorityRevision: retirement.authority,
      phase: retirement.phase,
      after: retirement.after,
      agent: family.discovery?.agent ?? key.split(':', 1)[0]
    })
    if (!result.accepted) {
      throw new SessionSearchOperationError('Container cleanup was superseded')
    }
    retirement.after = result.after
    if (!result.after) {
      if (retirement.phase === 'raw') {
        retirement.phase = 'receipts'
      } else {
        physical.retirement = undefined
      }
    }
  }
}
