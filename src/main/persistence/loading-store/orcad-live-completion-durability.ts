import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'

/** Exact journal bytes observed on load or after an acknowledged primary-profile write. */
export class OrcadLiveCompletionDurability {
  private journals = new Map<string, string>()

  static capture(value: unknown): Map<string, string> {
    const journals = new Map<string, string>()
    const seen = new Set<string>()
    if (!Array.isArray(value)) {
      return journals
    }
    for (const entry of value) {
      const migrationId = entry?.manifest?.migrationId
      if (typeof migrationId !== 'string') {
        continue
      }
      if (seen.has(migrationId)) {
        journals.delete(migrationId)
        continue
      }
      seen.add(migrationId)
      if (entry?.version === 2 && entry.phase === 'source-retired') {
        journals.set(migrationId, serializeOrcadMigrationValue(entry))
      }
    }
    return journals
  }

  acknowledge(snapshot: ReadonlyMap<string, string>): void {
    this.journals = new Map(snapshot)
  }

  invalidate(): void {
    this.journals.clear()
  }

  matches(candidate: { manifest: { migrationId: string } }): boolean {
    return (
      this.journals.get(candidate.manifest.migrationId) === serializeOrcadMigrationValue(candidate)
    )
  }
}
