import type { BrowserSessionProfile } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { BrowserSessionMeta } from './browser-session-meta-store'
import type { BrowserSessionProfileMap } from './browser-session-profile-map'

/** Label/source edits share one persistence path: the built-in profile lives in metadata, the rest in the profile list. */
export class BrowserSessionProfileLabelStore {
  constructor(
    private readonly profiles: BrowserSessionProfileMap,
    private readonly persistMeta: (updates: Partial<BrowserSessionMeta>) => void,
    private readonly persistProfiles: () => void,
    private readonly notify: () => void
  ) {}

  updateSource(
    profileId: string,
    source: BrowserSessionProfile['source']
  ): BrowserSessionProfile | null {
    const profile = this.profiles.get(profileId)
    if (!profile) {
      return null
    }
    return this.apply(profileId, { ...profile, source }, { defaultSource: source })
  }

  /** Null for an unknown profile or a blank label; the id, partition and cookies stay. */
  rename(profileId: string, label: string): BrowserSessionProfile | null {
    const profile = this.profiles.get(profileId)
    const trimmed = label.trim()
    if (!profile || !trimmed) {
      return null
    }
    return this.apply(profileId, { ...profile, label: trimmed }, { defaultLabel: trimmed })
  }

  private apply(
    profileId: string,
    updated: BrowserSessionProfile,
    defaultMeta: Partial<BrowserSessionMeta>
  ): BrowserSessionProfile {
    this.profiles.set(profileId, updated)
    if (profileId === 'default') {
      this.persistMeta(defaultMeta)
    } else {
      this.persistProfiles()
    }
    this.notify()
    return updated
  }
}
