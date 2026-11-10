import { sessionSearchRecordPages } from './session-search-catalog-pages'
import { SessionSearchContainerSources } from './session-search-container-sources'
import { SessionSearchCatalogClient } from './session-search-catalog-client'
import { throwIfAiVaultScanCancelled } from '../ai-vault/ai-vault-scan-cancellation'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import type { FileWithMtime, SessionFileDiscovery } from '../ai-vault/session-scanner-types'
import { splitSyntheticSessionSource } from './session-search-synthetic-sources'

/** Source observations progress independently from the selected publication. */
export class SessionSearchContainerInventory extends SessionSearchContainerSources {
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
        this.acceptedProofs.delete(`${key.split(':', 1)[0]}:${path}`)
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
        const files = new SessionSearchCatalogClient<{
          file: FileWithMtime
          epoch: number
          changed: boolean
        }>(`container:${key}:${path}`, this.request!)
        physical = {
          files,
          epoch: 0,
          get pending() {
            return files.readySize
          },
          fullDue: true
        }
        family.physical.set(path, physical)
      }
      if (physical.retiring) {
        physical.retiring = false
        physical.fullDue = true
      }
      if (physical.retirement) {
        await this.advanceRetirement(key, path, family, physical)
        continue
      }
      const retryKey = `${key}:${path}`
      const before = await this.signature(path, signal)
      const proofKey = `${key.split(':', 1)[0]}:${path}`
      if (!before.known || physical.signature !== before.signature) {
        this.acceptedProofs.delete(proofKey)
      }
      if (physical.identity !== before.identity && before.known) {
        physical.fullDue = true
        this.retries.wake(retryKey)
      }
      if (before.identity === '' && before.known && family.discovery) {
        await this.release(key, path, family, physical)
        continue
      }
      const full =
        physical.fullDue &&
        !this.retries.heldOut(`paths:${key.slice(key.indexOf(':') + 1)}`) &&
        this.retries.mayAttempt(retryKey)
      const discovery = await read([path], full ? Infinity : this.recentLimit)
      family.discovery = { ...discovery, files: [] }
      throwIfAiVaultScanCancelled(signal)
      const epoch = full ? ++physical.epoch : 0
      let currentCount = 0
      for (const files of sessionSearchRecordPages(discovery.files)) {
        currentCount += files.length
        const result = await physical.files.transition({
          kind: 'container-apply',
          scope: physical.files.scope,
          rows: files.map((file) => ({
            file,
            id: splitSyntheticSessionSource(file.path)?.id ?? ''
          })),
          epoch,
          full,
          proof: this.acceptedProofs.has(proofKey) ? physical.proof : undefined
        })
        if (result.invalidProof) {
          this.acceptedProofs.delete(proofKey)
        }
      }
      const after = await this.signature(path, signal)
      const complete = discovery.complete !== false
      const stable = complete && before.known && after.known && before.signature === after.signature
      if (full && complete) {
        physical.fullDue = before.known && after.known && before.identity !== after.identity
        this.retries.delete(retryKey)
        // Empty also means an unknown schema under the existing reader contract.
        if (stable && currentCount) {
          physical.retirement = { epoch }
          await this.advanceRetirement(key, path, family, physical)
        }
      }
      if (full && !complete) {
        this.retries.fail(retryKey)
      }
      if (!stable) {
        this.acceptedProofs.delete(proofKey)
      }
      physical.signature = after.signature
      physical.identity = after.known ? after.identity : physical.identity
      if (changes.length >= 256) {
        continue
      }
      const pending = await physical.files.transition({
        kind: 'container-drain',
        scope: physical.files.scope,
        limit: 256 - changes.length
      })
      for (const row of pending.rows ?? []) {
        changes.push(physical.files.decode(row).file)
      }
    }
    // A refused family listing cannot certify that a physical source disappeared.
    if (enumerationComplete) {
      for (const [path, physical] of family.physical) {
        if (!paths.includes(path)) {
          await this.release(key, path, family, physical)
        }
      }
    }
    family.discovery ??= await read([], this.recentLimit)
    await this.drainRetirements()
    return { ...family.discovery, files: changes, sourceOrder: family.sourceOrder }
  }
  async end(): Promise<void> {
    await this.drainRetirements()
    for (const root of this.pathLists.keys()) {
      if (!this.seenPathLists.has(root)) {
        this.pathLists.delete(root)
        this.retries.delete(`paths:${root}`)
      }
    }
    for (const [key, family] of this.families) {
      if (!this.seen.has(key)) {
        for (const [path, physical] of family.physical) {
          await this.release(key, path, family, physical)
        }
        if (!family.physical.size) {
          this.families.delete(key)
        }
      }
    }
  }
  hasChanges(key: string): boolean {
    return [...(this.families.get(key)?.physical.values() ?? [])].some(
      (physical) => physical.pending > 0
    )
  }
  async drain(key: string): Promise<SessionFileDiscovery | undefined> {
    const family = this.families.get(key)
    if (!family?.discovery) {
      return
    }
    const changes: FileWithMtime[] = []
    for (const physical of family.physical.values()) {
      if (!physical.pending || changes.length >= 256) {
        continue
      }
      const page = await physical.files.transition({
        kind: 'container-drain',
        scope: physical.files.scope,
        limit: 256 - changes.length
      })
      for (const row of page.rows ?? []) {
        changes.push(physical.files.decode(row).file)
      }
    }
    return { ...family.discovery, files: changes, sourceOrder: family.sourceOrder }
  }
  clear(): void {
    this.pathLists.clear()
    this.families.clear()
    this.retries.clear()
    this.acceptedProofs.clear()
    this.removed.clear()
  }
}
