import type { AiVaultAgent } from '../../shared/ai-vault-types'
import type { AiVaultScanReadingProgress } from '../../shared/ai-vault-scan-progress'
import type { SessionFileCandidate } from './session-scanner-types'

type Ownership = { globalRemaining: number; owners: number; parsed: boolean }
export type ScanReadPass = 'global' | 'walk' | 'bucket'
const OWNER = { walk: 1, bucket: 2 } as const

/** Logical membership is fixed before execution; repeated execution visits stay independent. */
export class AiVaultScanWorkload {
  private readonly keys = new Map<AiVaultAgent, Map<string, Ownership>>()
  private readonly agents = new Map<AiVaultAgent, AiVaultScanReadingProgress>()

  register(candidate: SessionFileCandidate, pass: ScanReadPass): void {
    this.registerPath(candidate.agent, candidate.file.path, pass)
  }

  registerPath(agent: AiVaultAgent, path: string, pass: ScanReadPass): void {
    let keys = this.keys.get(agent)
    let key = keys?.get(path)
    if (!key) {
      this.counts(agent).total++
      // Walk-only paths are unique and cannot occur in bucket agents.
      if (pass === 'walk') {
        return
      }
      keys ??= new Map<string, Ownership>()
      key = { globalRemaining: 0, owners: 0, parsed: false }
      keys.set(path, key)
      this.keys.set(agent, keys)
    }
    if (pass === 'global') {
      key.globalRemaining++
    } else {
      key.owners |= OWNER[pass]
    }
  }

  settle(candidate: SessionFileCandidate, pass: ScanReadPass, parsed: boolean): void {
    this.settlePath(candidate.agent, candidate.file.path, pass, parsed)
  }

  settlePath(agent: AiVaultAgent, path: string, pass: ScanReadPass, parsed: boolean): void {
    const keys = this.keys.get(agent)
    const key = keys?.get(path)
    if (!key) {
      this.complete(agent, parsed)
      return
    }
    key.parsed ||= parsed
    if (pass === 'global') {
      key.globalRemaining--
    } else {
      key.owners &= ~OWNER[pass]
    }
    if (key.globalRemaining === 0 && key.owners === 0) {
      this.complete(agent, key.parsed)
      keys?.delete(path)
    }
  }

  *bucketPaths(agent: AiVaultAgent): Iterable<string> {
    for (const [path, key] of this.keys.get(agent) ?? []) {
      if ((key.owners & OWNER.bucket) !== 0) {
        yield path
      }
    }
  }

  snapshot(agent: AiVaultAgent): AiVaultScanReadingProgress {
    return { ...this.counts(agent) }
  }

  has(agent: AiVaultAgent): boolean {
    return this.agents.has(agent)
  }

  total(): AiVaultScanReadingProgress {
    const total = { done: 0, total: 0, skipped: 0 }
    for (const count of this.agents.values()) {
      total.done += count.done
      total.total += count.total
      total.skipped += count.skipped ?? 0
    }
    return total
  }

  private complete(agent: AiVaultAgent, parsed: boolean): void {
    const count = this.counts(agent)
    if (parsed) {
      count.done++
    } else {
      count.skipped = (count.skipped ?? 0) + 1
    }
  }

  private counts(agent: AiVaultAgent): AiVaultScanReadingProgress {
    let counts = this.agents.get(agent)
    if (!counts) {
      counts = { done: 0, total: 0, skipped: 0 }
      this.agents.set(agent, counts)
    }
    return counts
  }
}
