import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import { SessionObservationRetries } from '../ai-vault/session-observation-retries'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import type { FileWithMtime, SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { isMissingTranscriptPathError } from '../ai-vault/session-scanner-discovery'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { splitSyntheticSessionSource } from './session-search-synthetic-sources'

type Physical = {
  files: Map<string, FileWithMtime>
  signature?: string
  identity?: string
  fullDue: boolean
}
type Family = {
  discovery?: SessionFileDiscovery
  physical: Map<string, Physical>
  sourceOrder: ReadonlyMap<string, number>
}

/** Recent observations add facts; only a successful exhaustive observation can withdraw them. */
export class SessionSearchContainerInventory {
  private readonly pathLists = new Map<
    string,
    { paths: readonly string[]; complete: boolean; issues: AiVaultScanIssue[] }
  >()
  private seenPathLists = new Set<string>()
  private readonly families = new Map<string, Family>()
  private seen = new Set<string>()
  private recentLimit = 12
  private readonly retries = new SessionObservationRetries()
  readonly removed = new Map<string, Set<string>>()
  readonly proofs = new Map<string, ReadonlySet<string>>()

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
        if (physical.fullDue && !this.retries.heldOut(`${key}:${path}`)) {
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
  async discover(
    key: string,
    paths: readonly string[],
    read: (paths: readonly string[], limit: number) => Promise<SessionFileDiscovery>,
    _issues: readonly AiVaultScanIssue[],
    signal?: AbortSignal,
    enumerationComplete = true
  ): Promise<SessionFileDiscovery> {
    this.seen.add(key)
    let family = this.families.get(key)
    if (!family) {
      family = { physical: new Map(), sourceOrder: new Map() }
      this.families.set(key, family)
    }
    if (!enumerationComplete) {
      for (const path of family.physical.keys()) {
        this.proofs.delete(`${key.split(':', 1)[0]}:${path}`)
      }
    } else if (
      family.sourceOrder.size !== paths.length ||
      paths.some((path, rank) => family.sourceOrder.get(path) !== rank)
    ) {
      family.sourceOrder = new Map(paths.map((path, rank) => [path, rank]))
    }
    const changes: FileWithMtime[] = []
    for (const path of paths) {
      let physical = family.physical.get(path)
      if (!physical) {
        physical = { files: new Map(), fullDue: true }
        family.physical.set(path, physical)
      }
      const retryKey = `${key}:${path}`
      const before = await this.signature(path, signal)
      const proofKey = `${key.split(':', 1)[0]}:${path}`
      if (!before.known || physical.signature !== before.signature) {
        this.proofs.delete(proofKey)
      }
      if (physical.identity !== before.identity && before.known) {
        physical.fullDue = true
        this.retries.wake(retryKey)
      }
      if (before.identity === '' && before.known && family.discovery) {
        this.release(key, path, family, physical)
        continue
      }
      const full =
        physical.fullDue &&
        !this.retries.heldOut(`paths:${key.slice(key.indexOf(':') + 1)}`) &&
        this.retries.mayAttempt(retryKey)
      const discovery = await read([path], full ? Infinity : this.recentLimit)
      family.discovery = discovery
      throwIfAiVaultScanCancelled(signal)
      const current = new Map<string, FileWithMtime>()
      for (const file of discovery.files) {
        current.set(file.path, file)
        const source = splitSyntheticSessionSource(file.path)
        const proof = this.proofs.get(proofKey)
        if (source && proof && !proof.has(source.id)) {
          this.proofs.delete(proofKey)
        }
        const previous = physical.files.get(file.path)
        if (
          !previous ||
          previous.mtimeMs !== file.mtimeMs ||
          previous.sizeBytes !== file.sizeBytes
        ) {
          changes.push(file)
        }
        physical.files.set(file.path, file)
      }
      const after = await this.signature(path, signal)
      const complete = discovery.complete !== false
      const stable = complete && before.known && after.known && before.signature === after.signature
      if (full && complete) {
        physical.fullDue = before.known && after.known && before.identity !== after.identity
        this.retries.delete(retryKey)
        // Empty also means an unknown schema under the existing reader contract.
        if (stable && current.size) {
          for (const old of physical.files.keys()) {
            if (!current.has(old)) {
              this.remove(old, discovery.agent)
              physical.files.delete(old)
            }
          }
          const ids = new Set<string>()
          for (const file of current.values()) {
            const source = splitSyntheticSessionSource(file.path)
            if (source) {
              ids.add(source.id)
            }
          }
          this.proofs.set(proofKey, ids)
        }
      }
      if (full && !complete) {
        this.retries.fail(retryKey)
      }
      if (!stable) {
        this.proofs.delete(proofKey)
      }
      physical.signature = after.signature
      physical.identity = after.known ? after.identity : physical.identity
    }
    // A refused family listing cannot certify that a physical source disappeared.
    if (enumerationComplete) {
      for (const [path, physical] of family.physical) {
        if (!paths.includes(path)) {
          this.release(key, path, family, physical)
        }
      }
    }
    family.discovery ??= await read([], this.recentLimit)
    return { ...family.discovery, files: changes, sourceOrder: family.sourceOrder }
  }
  end(): void {
    for (const root of this.pathLists.keys()) {
      if (!this.seenPathLists.has(root)) {
        this.pathLists.delete(root)
        this.retries.delete(`paths:${root}`)
      }
    }
    for (const [key, family] of this.families) {
      if (!this.seen.has(key)) {
        for (const [path, physical] of family.physical) {
          this.release(key, path, family, physical)
        }
        this.families.delete(key)
      }
    }
  }
  clear(): void {
    this.pathLists.clear()
    this.families.clear()
    this.retries.clear()
    this.proofs.clear()
    this.removed.clear()
  }
  private remove(path: string, agent: string): void {
    const agents = this.removed.get(path) ?? new Set<string>()
    agents.add(agent)
    this.removed.set(path, agents)
  }
  private release(key: string, path: string, family: Family, physical: Physical): void {
    for (const old of physical.files.keys()) {
      if (family.discovery) {
        this.remove(old, family.discovery.agent)
      }
    }
    this.retries.delete(`${key}:${path}`)
    this.proofs.delete(`${key.split(':', 1)[0]}:${path}`)
    family.physical.delete(path)
  }
  private async signature(path: string, signal?: AbortSignal) {
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
