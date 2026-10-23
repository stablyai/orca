import {
  mergeUsageRequestEnabled,
  normalizeUsageRequestEnabled,
  USAGE_REQUEST_PROVIDERS
} from '../../shared/usage-request-policy'
import type { RuntimeStore } from './runtime-store-contract'
import type {
  RuntimeClientSettings,
  RuntimeClientSettingsUpdate
} from './runtime-client-settings-shape'

type UsagePolicyStore = Pick<
  RuntimeStore,
  'getSettings' | 'updateSettings' | 'getUI' | 'updateUI' | 'runDurableMutation'
>

export function projectUsageRequestSettings(
  store: UsagePolicyStore,
  ownsUsagePoller: boolean
): Pick<
  RuntimeClientSettings,
  'usageRequestPolicyVersion' | 'usageRequestEnabled' | 'antigravityUsageEnabled'
> {
  if (
    !ownsUsagePoller ||
    !store.getUI ||
    !store.updateUI ||
    !store.updateSettings ||
    !store.runDurableMutation
  ) {
    return {}
  }
  return {
    usageRequestPolicyVersion: 1,
    usageRequestEnabled: normalizeUsageRequestEnabled(store.getSettings().usageRequestEnabled),
    antigravityUsageEnabled: store.getUI().statusBarItems.includes('antigravity')
  }
}

export async function updateUsageRequestSettings(
  store: UsagePolicyStore,
  updates: RuntimeClientSettingsUpdate,
  ownsUsagePoller: boolean
): Promise<void> {
  if (!('usageRequestEnabled' in updates) && !('antigravityUsageEnabled' in updates)) {
    return
  }
  if (
    projectUsageRequestSettings(store, ownsUsagePoller).usageRequestPolicyVersion !== 1 ||
    !store.runDurableMutation ||
    !store.updateSettings ||
    !store.getUI ||
    !store.updateUI
  ) {
    throw new Error('usage_policy_unavailable')
  }
  if (
    'antigravityUsageEnabled' in updates &&
    typeof updates.antigravityUsageEnabled !== 'boolean'
  ) {
    throw new Error('invalid_usage_policy')
  }
  const applySettings = store.updateSettings.bind(store)
  const getUI = store.getUI.bind(store)
  const applyUI = store.updateUI.bind(store)
  await store.runDurableMutation(() => {
    const before = normalizeUsageRequestEnabled(store.getSettings().usageRequestEnabled)
    const beforeAntigravity = getUI().statusBarItems.includes('antigravity')
    const patch = normalizeUsageRequestEnabled(updates.usageRequestEnabled)
    const applied = mergeUsageRequestEnabled(before, patch)
    if ('usageRequestEnabled' in updates) {
      applySettings({ usageRequestEnabled: applied }, { notifyListeners: true })
    }
    if (typeof updates.antigravityUsageEnabled === 'boolean') {
      setAntigravityUsageEnabled(getUI, applyUI, updates.antigravityUsageEnabled)
    }
    return {
      value: undefined,
      rollback: () => {
        const current = normalizeUsageRequestEnabled(store.getSettings().usageRequestEnabled)
        const rollback = { ...current }
        for (const provider of USAGE_REQUEST_PROVIDERS) {
          if (provider === 'antigravity' || patch[provider] === undefined) {
            continue
          }
          if (current[provider] === applied[provider]) {
            rollback[provider] = before[provider] !== false
          }
        }
        applySettings({ usageRequestEnabled: rollback }, { notifyListeners: true })
        if (
          typeof updates.antigravityUsageEnabled === 'boolean' &&
          getUI().statusBarItems.includes('antigravity') === updates.antigravityUsageEnabled
        ) {
          setAntigravityUsageEnabled(getUI, applyUI, beforeAntigravity)
        }
      }
    }
  })
}

function setAntigravityUsageEnabled(
  getUI: NonNullable<RuntimeStore['getUI']>,
  updateUI: NonNullable<RuntimeStore['updateUI']>,
  enabled: boolean
): void {
  const items = getUI().statusBarItems
  if (items.includes('antigravity') === enabled) {
    return
  }
  updateUI({
    statusBarItems: enabled
      ? [...items, 'antigravity']
      : items.filter((item) => item !== 'antigravity')
  })
}
