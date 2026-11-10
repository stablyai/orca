import {
  SessionSearchCatalogClient,
  type SessionSearchCatalogRequest
} from './session-search-catalog-client'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import { SessionObservationRetries } from '../ai-vault/session-observation-retries'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import type { FileWithMtime, SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { isMissingTranscriptPathError } from '../ai-vault/session-scanner-discovery'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'

type Physical = {
  files: SessionSearchCatalogClient<{ file: FileWithMtime; epoch: number; changed: boolean }>
  epoch: number
  pending: number
  proof?: number
  signature?: string
  identity?: string
  fullDue: boolean
  retiring?: boolean
  retirement?: { epoch: number; after?: string }
}
type Family = {
  discovery?: SessionFileDiscovery
  physical: Map<string, Physical>
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
  protected retirement: SessionSearchCatalogClient<string> | undefined
  protected get retirementCount(): number {
    return this.retirement?.size ?? 0
  }
  protected readonly acceptedProofs = new Map<string, Physical>()
  attach(request: SessionSearchCatalogRequest): void {
    this.request ??= request
    this.retirement ??= new SessionSearchCatalogClient('container-retirements', request)
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
    const page = await physical.files.page({ group: id, limit: 1 })
    return page.rows.some(({ value }) => value.epoch === physical.proof)
  }

  begin(full: boolean, recentLimit: number): void {
    this.seen = new Set()
    this.seenPathLists = new Set()
    this.retries.begin(full)
    this.recentLimit = recentLimit
    this.removed.clear()
    if (full) {
      for (const family of this.families.values()) {
        for (const physical of family.physical.values()) {
          physical.fullDue = true
        }
      }
    }
  }
  get pending(): boolean {
    if (this.retirementCount) {
      return true
    }
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
          (physical.pending || physical.fullDue || physical.retiring || physical.retirement) &&
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
  protected async remove(path: string, agent: string): Promise<void> {
    const key = `${agent}:${path}`
    if (!(await this.retirement!.get(key))) {
      await this.retirement!.put(key, path, { parent: agent })
    }
  }
  protected async drainRetirements(): Promise<void> {
    const page = await this.retirement!.page({ limit: Math.max(1, 256 - this.removed.size) })
    for (const { key, value: path } of page.rows) {
      const agent = key.slice(0, key.indexOf(':'))
      const agents = this.removed.get(path) ?? new Set<string>()
      agents.add(agent)
      this.removed.set(path, agents)
    }
    await this.retirement!.deletePage(page.rows.map(({ key }) => key))
  }
  protected async release(
    key: string,
    path: string,
    family: Family,
    physical: Physical
  ): Promise<void> {
    physical.retiring = true
    physical.retirement = undefined
    const result = await physical.files.transition({
      kind: 'container-retire',
      scope: physical.files.scope,
      agent: family.discovery?.agent ?? key.split(':', 1)[0]
    })
    this.retries.delete(`${key}:${path}`)
    this.acceptedProofs.delete(`${key.split(':', 1)[0]}:${path}`)
    if (!result.after) {
      family.physical.delete(path)
    }
  }
  protected async advanceRetirement(
    key: string,
    path: string,
    family: Family,
    physical: Physical
  ): Promise<void> {
    const retirement = physical.retirement
    if (!retirement) {
      return
    }
    const result = await physical.files.transition({
      kind: 'container-retire',
      scope: physical.files.scope,
      epoch: retirement.epoch,
      after: retirement.after,
      agent: family.discovery?.agent ?? key.split(':', 1)[0]
    })
    retirement.after = result.after
    if (!result.after) {
      physical.proof = retirement.epoch
      this.acceptedProofs.set(`${key.split(':', 1)[0]}:${path}`, physical)
      physical.retirement = undefined
    }
  }
  protected async signature(path: string, signal?: AbortSignal) {
    let known = true
    let identity = ''
    const facts = await Promise.all(
      [path, `${path}-wal`].map(async (input) => {
        try {
          const stat = await wslGatedStat(input, 'scan', signal)
          const id = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`
          if (input === path) {
            identity = id
          }
          return `${id}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`
        } catch (error) {
          throwIfAiVaultScanCancelled(signal)
          if (isMissingTranscriptPathError(error)) {
            return 'missing'
          }
          known = false
          return 'unknown'
        }
      })
    )
    return { known, identity, signature: facts.join('|') }
  }
}
