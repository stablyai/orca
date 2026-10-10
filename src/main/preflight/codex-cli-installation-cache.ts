import type { CodexCliInstallation } from '../../shared/codex-cli-installation'

export type CodexInstallationEvidence = { installation: CodexCliInstallation; expiresAt: number }
type CacheEntry = {
  fingerprint: string
  expiresAt: number
  result: Promise<CodexInstallationEvidence>
}

export class CodexCliInstallationCache {
  private readonly entries = new Map<string, CacheEntry>()

  clear(): void {
    this.entries.clear()
  }

  async read(
    host: string,
    fingerprint: string,
    probe: () => Promise<CodexCliInstallation>,
    lifetimeMs = 30_000
  ): Promise<CodexCliInstallation> {
    return (await this.readEvidence(host, fingerprint, probe, lifetimeMs)).installation
  }

  async readEvidence(
    host: string,
    fingerprint: string,
    probe: () => Promise<CodexCliInstallation>,
    lifetimeMs = 30_000
  ): Promise<CodexInstallationEvidence> {
    const existing = this.entries.get(host)
    if (existing?.fingerprint === fingerprint && existing.expiresAt > Date.now()) {
      return existing.result
    }
    const result = probe().then((installation) => ({
      installation,
      expiresAt: Date.now() + Math.min(lifetimeMs, 30_000)
    }))
    const entry: CacheEntry = { fingerprint, expiresAt: Infinity, result }
    this.entries.set(host, entry)
    try {
      const result = await entry.result
      entry.expiresAt = result.expiresAt
      return result
    } catch (error) {
      if (this.entries.get(host) === entry) {
        this.entries.delete(host)
      }
      throw error
    } finally {
      if (this.entries.size > 128) {
        const oldest = this.entries.keys().next().value
        if (oldest !== undefined && oldest !== host) {
          this.entries.delete(oldest)
        }
      }
    }
  }
}
