import { writeFileAtomicallyIfUnchanged } from '../../../filesystem/atomic-file-publication'
import { observeAgentStateFile } from '../codex-path-observation'
import { writeTomlConfigAtomically } from '../toml/config-toml-atomic-write'
import { upsertPromotedSettingsInContent } from './codex-config-settings-upsert'
import {
  applyCodexRegistrationPromotions,
  readCodexRegistrationIdentity,
  type CodexRegistrationPromotion
} from './config-plugin-registration-promotion'
import { resolvePromotionWriteTarget } from './config-settings-promotion-write-target'
import {
  normalizeCodexRegistrationValue,
  readCodexRegistrationEntries,
  readCodexRegistrationRootsDefinedOutsideTables
} from '../toml/config-toml-plugin-registration-tables'
import { readPromotedSettingValuesFromContent } from '../toml/config-toml-promoted-setting-values'

export const CODEX_GUEST_CARRY_FORWARD_MARKER = '# orca: tab edit kept from before the update'

/**
 * Tab edits a one-way WSL build (v1.4.27x) kept as marked lines in the managed copy instead of
 * writing the distro's config. Read for one release so the first two-way pass promotes them.
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

function readNormalizedField(
  entries: ReturnType<typeof readCodexRegistrationEntries>,
  key: string,
  field: string
): string | null {
  const value = entries.get(key)?.fields.get(field)
  return value ? normalizeCodexRegistrationValue(value.raw) : null
}

// A `[root.name]` table beside an inline or dotted definition of that root would redefine a key.
function canAppendRegistration(key: string, definedOutsideTables: ReadonlySet<string>): boolean {
  return !definedOutsideTables.has(key) && !definedOutsideTables.has(key.slice(0, key.indexOf(':')))
}

/**
 * Promote kept values into the distro config like any tab edit (a distro edit to the key wins) and
 * strip their marks from the managed copy. 'done' when nothing was left to write.
 */
export function promoteGuestCarryForward(
  runtimeTomlPath: string,
  runtimeConfig: string,
  systemTomlPath: string,
  carry: CodexGuestCarryForward
): 'done' | 'wrote' | 'superseded' {
  const writePath = resolvePromotionWriteTarget(systemTomlPath).path
  const system = observeAgentStateFile(writePath)
  if (system.kind === 'indeterminate') {
    throw system.error
  }
  // A missing or blank (maybe unhydrated) distro config keeps the values for a later pass.
  if (system.kind === 'absent' || system.value.trim() === '') {
    return 'done'
  }
  let wrote = false
  const kept = retainGuestCarryForward(carry, system.value)
  if (!isGuestCarryForwardEmpty(kept)) {
    const next = applyCodexRegistrationPromotions(
      upsertPromotedSettingsInContent(
        system.value,
        new Map([...kept.settings].map(([key, { raw }]) => [key, raw]))
      ),
      kept.registrations.map(({ promotion }) => promotion)
    )
    if (next !== system.value) {
      if (!writeTomlConfigAtomically(writePath, next, system.value, { backup: false })) {
        return 'superseded'
      }
      wrote = true
    }
  }
  const stripped = stripCarryForwardMarkers(runtimeConfig)
  if (stripped !== runtimeConfig) {
    if (
      !writeFileAtomicallyIfUnchanged(runtimeTomlPath, runtimeConfig, stripped, { mode: 0o600 })
    ) {
      return 'superseded'
    }
    wrote = true
  }
  return wrote ? 'wrote' : 'done'
}

function stripCarryForwardMarkers(config: string): string {
  return config
    .split('\n')
    .filter((line) => line.trim() !== CODEX_GUEST_CARRY_FORWARD_MARKER)
    .map((line) => {
      const cr = line.endsWith('\r') ? '\r' : ''
      const body = cr ? line.slice(0, -1) : line
      return body.endsWith(CODEX_GUEST_CARRY_FORWARD_MARKER)
        ? `${body.slice(0, -CODEX_GUEST_CARRY_FORWARD_MARKER.length).trimEnd()}${cr}`
        : line
    })
    .join('\n')
}
