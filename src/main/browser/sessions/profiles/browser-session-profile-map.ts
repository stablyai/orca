import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'

/** Profiles by id, with a partition lookup kept in step with every change instead of a scan. */
export class BrowserSessionProfileMap extends Map<string, BrowserSessionProfile> {
  private idsByPartition: Map<string, string> | null = null

  override set(id: string, profile: BrowserSessionProfile): this {
    this.idsByPartition = null
    return super.set(id, profile)
  }

  override delete(id: string): boolean {
    this.idsByPartition = null
    return super.delete(id)
  }

  override clear(): void {
    this.idsByPartition = null
    super.clear()
  }

  idForPartition(partition: string): string | null {
    if (!this.idsByPartition) {
      const ids = new Map<string, string>()
      for (const profile of this.values()) {
        // The first profile listed with a partition owns it, as the scan this replaces found.
        if (!ids.has(profile.partition)) {
          ids.set(profile.partition, profile.id)
        }
      }
      this.idsByPartition = ids
    }
    return this.idsByPartition.get(partition) ?? null
  }
}
