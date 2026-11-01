import { resolveAiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RuntimeStore } from './runtime-store-contract'

/** After persistence, reach the host-owned index: desktop scanner child or orcad instance. Hosts without one still save without reconstruction. */
export type SessionSearchSettingsApply = (
  before: Pick<GlobalSettings, 'aiVaultSearch'>,
  after: Pick<GlobalSettings, 'aiVaultSearch'>
) => void

/** Only the two store members this write needs, so a caller need not own the whole runtime store. */
export type SessionSearchSettingsStore = Pick<RuntimeStore, 'getSettings' | 'updateSettings'>

/** Consent for this host's transcript index, written by a paired client rather than the local UI. */
export class RuntimeSessionSearchSettingsController {
  constructor(
    private readonly store: SessionSearchSettingsStore | null,
    private readonly apply: SessionSearchSettingsApply | null
  ) {}

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.store?.getSettings || !this.store.updateSettings) {
      throw new Error('runtime_unavailable')
    }
    const before = this.store.getSettings()
    this.store.updateSettings(
      { aiVaultSearch: { ...resolveAiVaultSearchSettings(before), enabled } },
      { notifyListeners: true }
    )
    this.apply?.(before, this.store.getSettings())
  }
}
