import { resolveAiVaultSearchSettings } from '../../shared/ai-vault-search-settings'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { RuntimeStore } from './runtime-store-contract'

/**
 * How this host reaches the index it owns after the store write lands: the scanner
 * child on the desktop, the in-process instance on orcad. Null on a host that owns
 * none, where the write is still recorded and nothing is reconstructed.
 */
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
