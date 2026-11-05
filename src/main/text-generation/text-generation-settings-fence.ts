import { resolveTextGenerationParams } from './commit-message-text-generation'
import { readSettingsKeyRevision } from '../persistence/applying-settings/settings-key-revisions'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { resolveLocalAccountRuntimeTarget } from '../../shared/local-account-runtime'

type LocalAccountRuntimeSettings = Parameters<typeof resolveLocalAccountRuntimeTarget>[0]

/** Requiring every key in the record makes a new settings input a compile error until it is fenced. */
function exhaustiveSettingsKeys<S>(keys: Record<keyof S & string, true>): (keyof S & string)[] {
  return Object.keys(keys).filter((key): key is keyof S & string => Object.hasOwn(keys, key))
}

export const LOCAL_ACCOUNT_RUNTIME_SETTINGS_KEYS =
  exhaustiveSettingsKeys<LocalAccountRuntimeSettings>({
    localAccountRuntime: true,
    localAccountWslDistro: true,
    localWindowsRuntimeDefault: true
  })

// Unrelated settings writes must not look like a Stop; a relevant change stays invalid even if reverted.
export function createSettingsFence<S extends Partial<GlobalSettings>>(
  getSettings: () => S,
  keys: readonly (keyof S & string)[],
  select: (settings: S) => unknown,
  initial?: { settings: S; selected: unknown }
): () => boolean {
  let seen = initial?.settings ?? getSettings()
  const revisions = keys.map((key) => readSettingsKeyRevision(seen, key))
  let expected: string | undefined = initial && JSON.stringify(initial.selected)
  // Untracked hosts (tests, plain getters) can only compare values, so they need the baseline up front.
  if (expected === undefined && revisions.includes(undefined)) {
    expected = JSON.stringify(select(seen))
  }
  let valid = true
  return () => {
    if (!valid) {
      return false
    }
    const latest = getSettings()
    if (latest === seen) {
      return true
    }
    const latestRevisions = keys.map((key) => readSettingsKeyRevision(latest, key))
    if (revisions.includes(undefined) || latestRevisions.includes(undefined)) {
      expected ??= JSON.stringify(select(seen))
      valid = JSON.stringify(select(latest)) === expected
    } else {
      valid = latestRevisions.every((revision, index) => revision === revisions[index])
    }
    seen = latest
    return valid
  }
}

type FencedSettings = Parameters<typeof resolveTextGenerationParams>[0] & {
  textGenerationSubscriptionFailoverEnabled?: boolean
}
type Route =
  Parameters<typeof resolveTextGenerationParams> extends [unknown, ...infer Rest] ? Rest : never

const FENCED_SETTINGS_KEYS = exhaustiveSettingsKeys<FencedSettings>({
  defaultTuiAgent: true,
  agentCmdOverrides: true,
  commitMessageAi: true,
  sourceControlAi: true,
  disabledTuiAgents: true,
  textGenerationSubscriptionFailoverEnabled: true
})

export function createTextGenerationParamsFence<S extends FencedSettings>(
  getSettings: () => S,
  ...route: Route
): () => boolean {
  return createResolvedTextGenerationParamsFence(getSettings, undefined, ...route)
}

export function createResolvedTextGenerationParamsFence<S extends FencedSettings>(
  getSettings: () => S,
  initial: { settings: S; resolved: ReturnType<typeof resolveTextGenerationParams> } | undefined,
  ...route: Route
): () => boolean {
  const select = (settings: S) => [
    resolveTextGenerationParams(settings, ...route),
    settings.textGenerationSubscriptionFailoverEnabled === true
  ]
  return createSettingsFence(
    getSettings,
    FENCED_SETTINGS_KEYS,
    select,
    initial && {
      settings: initial.settings,
      selected: [
        initial.resolved,
        initial.settings.textGenerationSubscriptionFailoverEnabled === true
      ]
    }
  )
}
