import type { observeAgentStateFile } from '../codex-path-observation'
import type { CodexSettingsBaseline } from './config-settings-baseline'
import { collectPromotionChanges } from './config-settings-promotion-changes'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  applyCodexRegistrationPromotions,
  planCodexRegistrationPromotion,
  readCodexRegistrationIdentity,
  type CodexRegistrationPromotion
} from './config-plugin-registration-promotion'
import {
  normalizeCodexRegistrationValue,
  readCodexRegistrationEntries,
  readCodexRegistrationRootsDefinedOutsideTables
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
  /** `system` is the distro's normalized field value (null for appends or an absent field) and `identity` its source. */
  registrations: readonly CodexGuestCarriedRegistration[]
}

export type CodexGuestCarriedRegistration = {
  promotion: CodexRegistrationPromotion
  system: string | null
  identity: string | null
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
      [...updates].map(([key, raw]) => [
        key,
        { raw: stripCarryForwardMarker(raw), system: systemValues.get(key)?.raw ?? null }
      ])
    ),
    registrations: registrations.map(stripRegistrationMarker).map((promotion) => {
      const entry = promotion.kind === 'field' ? systemEntries.get(promotion.key) : undefined
      return {
        promotion,
        system:
          promotion.kind === 'field'
            ? readNormalizedField(systemEntries, promotion.key, promotion.field)
            : null,
        identity: entry ? readCodexRegistrationIdentity(entry) : null
      }
    })
  }
}

// A pass cut off before its baseline write leaves marked lines that the next pass reads as tab edits.
function stripCarryForwardMarker(raw: string): string {
  return raw.endsWith(CODEX_GUEST_CARRY_FORWARD_MARKER)
    ? raw.slice(0, -CODEX_GUEST_CARRY_FORWARD_MARKER.length).trimEnd()
    : raw
}

function stripRegistrationMarker(
  promotion: CodexRegistrationPromotion
): CodexRegistrationPromotion {
  if (promotion.kind === 'append') {
    const lines = promotion.block.split('\n')
    const kept = lines.filter((line) => line.trimEnd() !== CODEX_GUEST_CARRY_FORWARD_MARKER)
    return { ...promotion, block: kept.join('\n') }
  }
  return promotion.raw === null
    ? promotion
    : { ...promotion, raw: stripCarryForwardMarker(promotion.raw) }
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
  return {
    settings: new Map(
      [...carry.settings].filter(([key, kept]) => {
        const current = systemValues.get(key)
        const currentRaw = current?.raw ?? null
        return !current?.multiline && currentRaw === kept.system && currentRaw !== kept.raw
      })
    ),
    registrations: retainCarriedRegistrations(carry.registrations, systemConfig)
  }
}

// A marketplace's refresh time and revision are kept or dropped together.
function retainCarriedRegistrations(
  carried: readonly CodexGuestCarriedRegistration[],
  systemConfig: string
): CodexGuestCarriedRegistration[] {
  const systemEntries = readCodexRegistrationEntries(systemConfig)
  const inlineRoots = readCodexRegistrationRootsDefinedOutsideTables(systemConfig)
  const droppedKeys = new Set<string>()
  for (const { promotion, system, identity } of carried) {
    const entry = systemEntries.get(promotion.key)
    if (promotion.kind === 'append') {
      if (entry || !canAppendRegistration(promotion.key, inlineRoots)) {
        droppedKeys.add(promotion.key)
      }
      continue
    }
    const current = readNormalizedField(systemEntries, promotion.key, promotion.field)
    const kept = promotion.raw === null ? null : normalizeCodexRegistrationValue(promotion.raw)
    if (
      !entry ||
      readCodexRegistrationIdentity(entry) !== identity ||
      current !== system ||
      current === kept
    ) {
      droppedKeys.add(promotion.key)
    }
  }
  return carried.filter(({ promotion }) => !droppedKeys.has(promotion.key))
}

export type CodexGuestRegeneration = { baseline: CodexSettingsBaseline | null }

/**
 * Plan from the mirror's own reads of both configs and apply the kept values to the distro config
 * in memory, before it is merged into the managed copy. Records the plan for the baseline snapshot.
 * The managed copy's write is checked against the same read, so a tab save in between is never
 * carried from an older read.
 */
export function applyGuestCarryForward(
  systemConfig: string,
  plan: { guestRegeneration?: CodexGuestRegeneration; guestCarryForward?: CodexGuestCarryForward },
  runtime: ReturnType<typeof observeAgentStateFile>
): string {
  if (!plan.guestRegeneration) {
    return systemConfig
  }
  const runtimeConfig = runtime.kind === 'present' ? runtime.value : ''
  const carry = planGuestRegenerationCarryForward(
    plan.guestRegeneration,
    runtimeConfig,
    systemConfig
  )
  plan.guestCarryForward = carry
  if (isGuestCarryForwardEmpty(carry)) {
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
function planGuestRegenerationCarryForward(
  { baseline }: CodexGuestRegeneration,
  runtimeConfig: string,
  systemConfig: string
): CodexGuestCarryForward {
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
  // Without a baseline that tracked registrations, a managed-copy table may be one the distro
  // dropped, so only registrations the distro still has carry.
  const trackedRegistrations = baseline?.registrations ?? new Map()
  const tracksRegistrations = baseline?.tracksRegistrations === true
  const inlineRoots = readCodexRegistrationRootsDefinedOutsideTables(systemConfig)
  const registrations = planCodexRegistrationPromotion(
    runtimeConfig,
    upsertPromotedSettingsInContent(systemConfig, updates),
    trackedRegistrations
  ).filter(
    (promotion) =>
      promotion.kind !== 'append' ||
      (tracksRegistrations && canAppendRegistration(promotion.key, inlineRoots))
  )
  return planGuestCarryForward(updates, registrations, systemConfig)
}

// A `[root.name]` table beside an inline or dotted definition of that root would redefine a key.
function canAppendRegistration(key: string, inlineRoots: ReadonlySet<string>): boolean {
  return !inlineRoots.has(key.slice(0, key.indexOf(':')))
}
