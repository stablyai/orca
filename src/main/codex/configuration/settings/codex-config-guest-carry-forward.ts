import { observeAgentStateFile } from '../codex-path-observation'
import type { CodexSettingsBaseline } from './config-settings-baseline'
import { collectPromotionChanges } from './config-settings-promotion-changes'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  applyCodexRegistrationPromotions,
  planCodexRegistrationPromotion,
  type CodexRegistrationPromotion
} from './config-plugin-registration-promotion'
import {
  normalizeCodexRegistrationValue,
  readCodexRegistrationEntries
} from '../toml/config-toml-plugin-registration-tables'
import { readPromotedSettingValuesFromContent } from '../toml/config-toml-promoted-setting-values'

export const CODEX_GUEST_CARRY_FORWARD_MARKER = '# orca: tab edit kept from before the update'

/**
 * Tab edits an older Orca had not yet written to a WSL distro's config. Orca no longer writes
 * that file, so each value stays an Orca line in the managed copy until the distro file changes it.
 */
export type CodexGuestCarryForward = {
  /** Structured key -> runtime raw, plus the distro raw it overrides. */
  settings: ReadonlyMap<string, { raw: string; system: string | null }>
  /** `system` is the distro's normalized field value; null for appends or an absent field. */
  registrations: readonly { promotion: CodexRegistrationPromotion; system: string | null }[]
}

export const EMPTY_GUEST_CARRY_FORWARD: CodexGuestCarryForward = {
  settings: new Map(),
  registrations: []
}

export function isGuestCarryForwardEmpty(carry: CodexGuestCarryForward): boolean {
  return carry.settings.size === 0 && carry.registrations.length === 0
}

function planGuestCarryForward(
  updates: ReadonlyMap<string, string>,
  registrations: readonly CodexRegistrationPromotion[],
  systemConfig: string
): CodexGuestCarryForward {
  const systemValues = readPromotedSettingValuesFromContent(systemConfig)
  const systemEntries = readCodexRegistrationEntries(systemConfig)
  return {
    settings: new Map(
      [...updates].map(([key, raw]) => [key, { raw, system: systemValues.get(key)?.raw ?? null }])
    ),
    registrations: registrations.map((promotion) => ({
      promotion,
      system:
        promotion.kind === 'field'
          ? readNormalizedField(systemEntries, promotion.key, promotion.field)
          : null
    }))
  }
}

/** Drop values the distro file has since changed or caught up with: its own edits win. */
export function retainGuestCarryForward(
  carry: CodexGuestCarryForward,
  systemConfig: string
): CodexGuestCarryForward {
  if (isGuestCarryForwardEmpty(carry)) {
    return carry
  }
  const systemValues = readPromotedSettingValuesFromContent(systemConfig)
  const systemEntries = readCodexRegistrationEntries(systemConfig)
  return {
    settings: new Map(
      [...carry.settings].filter(([key, kept]) => {
        const current = systemValues.get(key)
        const currentRaw = current?.raw ?? null
        return !current?.multiline && currentRaw === kept.system && currentRaw !== kept.raw
      })
    ),
    registrations: carry.registrations.filter(({ promotion, system }) => {
      if (promotion.kind === 'append') {
        return !systemEntries.has(promotion.key)
      }
      const current = readNormalizedField(systemEntries, promotion.key, promotion.field)
      const kept = promotion.raw === null ? null : normalizeCodexRegistrationValue(promotion.raw)
      return systemEntries.has(promotion.key) && current === system && current !== kept
    })
  }
}

/** Apply kept values to the distro config in memory, before it is merged into the managed copy. */
export function applyGuestCarryForward(
  systemConfig: string,
  carry: CodexGuestCarryForward | undefined
): string {
  if (!carry || isGuestCarryForwardEmpty(carry)) {
    return systemConfig
  }
  const withSettings = upsertPromotedSettingsInContent(
    systemConfig,
    new Map(
      [...carry.settings].map(([key, { raw }]) => [
        key,
        `${raw} ${CODEX_GUEST_CARRY_FORWARD_MARKER}`
      ])
    )
  )
  return applyCodexRegistrationPromotions(
    withSettings,
    carry.registrations.map(({ promotion }) =>
      promotion.kind === 'append'
        ? { ...promotion, block: `${CODEX_GUEST_CARRY_FORWARD_MARKER}\n${promotion.block}` }
        : promotion.raw === null
          ? promotion
          : { ...promotion, raw: `${promotion.raw} ${CODEX_GUEST_CARRY_FORWARD_MARKER}` }
    )
  )
}

function readNormalizedField(
  entries: ReturnType<typeof readCodexRegistrationEntries>,
  key: string,
  field: string
): string | null {
  const value = entries.get(key)?.fields.get(field)
  return value ? normalizeCodexRegistrationValue(value.raw) : null
}

/** An older Orca promoted tab edits on its next pass; keep the ones still pending at the update. */
export function planGuestRegenerationCarryForward(
  baseline: CodexSettingsBaseline | null,
  runtimeConfig: string,
  systemTomlPath: string
): CodexGuestCarryForward {
  if (baseline?.guestCarryForward && isGuestCarryForwardEmpty(baseline.guestCarryForward)) {
    return EMPTY_GUEST_CARRY_FORWARD
  }
  const systemObservation = observeAgentStateFile(systemTomlPath)
  if (systemObservation.kind === 'indeterminate') {
    throw systemObservation.error
  }
  const systemConfig = systemObservation.kind === 'present' ? systemObservation.value : ''
  if (baseline?.guestCarryForward) {
    return retainGuestCarryForward(baseline.guestCarryForward, systemConfig)
  }
  const updates = new Map<string, string>()
  if (baseline) {
    collectPromotionChanges({
      baseline,
      runtimeValues: readPromotedSettingValuesFromContent(runtimeConfig),
      systemValues: readPromotedSettingValuesFromContent(systemConfig),
      updates,
      conflicts: new Map(),
      runtimeValuesToPreserve: new Map()
    })
  }
  const registrations = planCodexRegistrationPromotion(
    runtimeConfig,
    upsertPromotedSettingsInContent(systemConfig, updates),
    baseline?.registrations ?? new Map()
  )
  return planGuestCarryForward(updates, registrations, systemConfig)
}
