import { createHash } from 'node:crypto'
import {
  createPortableSettingsBundle,
  getPortableSettingsCategoryDifferences,
  PORTABLE_SETTINGS_CATEGORIES,
  PortableSettingsBundleSchema,
  type PortableSettingsBundle,
  type PortableSettingsCategory
} from '../shared/portable-settings'
import type { KeybindingFileSnapshot } from '../shared/keybindings'
import type { RuntimeRpcResponse } from '../shared/runtime-rpc-envelope'
import type { GlobalSettings } from '../shared/types'

export function normalizePortableSettingsSyncCategories(
  categories: PortableSettingsCategory[]
): PortableSettingsCategory[] {
  const selected = new Set(categories)
  const normalized = PORTABLE_SETTINGS_CATEGORIES.filter((category) => selected.has(category))
  if (normalized.length === 0) {
    throw new Error('Select at least one settings category.')
  }
  return normalized
}

export function createPortableSettingsSyncSnapshot(
  settings: GlobalSettings,
  keybindings: Pick<KeybindingFileSnapshot, 'platform' | 'overrides'>,
  categories: PortableSettingsCategory[]
): { bundle: PortableSettingsBundle; hash: string } {
  const bundle = createPortableSettingsBundle(settings, keybindings)
  const selected = Object.fromEntries(
    PORTABLE_SETTINGS_CATEGORIES.filter((category) => categories.includes(category)).map(
      (category) => [category, bundle.categories[category]]
    )
  )
  return {
    bundle,
    hash: createHash('sha256').update(JSON.stringify(selected)).digest('hex')
  }
}

export function unwrapPortableSettingsSyncResponse<TResult>(
  response: RuntimeRpcResponse<unknown>
): TResult {
  if (response.ok === false) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

export function remotePortableSettingsNeedSync(
  localBundle: PortableSettingsBundle,
  remoteBundleInput: unknown,
  categories: PortableSettingsCategory[]
): boolean {
  const remoteBundle = PortableSettingsBundleSchema.parse(remoteBundleInput)
  return categories.some(
    (category) =>
      getPortableSettingsCategoryDifferences(localBundle, remoteBundle, category).length > 0
  )
}
