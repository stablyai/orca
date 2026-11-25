import { join } from 'node:path'
import { writeFileAtomicallyIfUnchanged } from '../../../filesystem/atomic-file-publication'
import type { CodexRegistrationPromotion } from './config-plugin-registration-promotion'
import { writeCodexSettingsBaseline, type CodexSettingsBaseline } from './config-settings-baseline'

const CODEX_GUEST_CARRY_FORWARD_MARKER = '# orca: tab edit kept from before the update'

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

/**
 * Turn kept values back into ordinary pending tab edits: strip their marks from the managed copy,
 * then point the baseline at the distro value each one overrode, so the engine promotes them (or a
 * newer tab edit) and a distro edit to the key still wins. A save racing the strip waits a pass.
 */
export function migrateGuestCarryForward(
  runtimeHomePath: string,
  runtimeConfig: string,
  baseline: CodexSettingsBaseline,
  carry: CodexGuestCarryForward
): void {
  const stripped = stripCarryForwardMarkers(runtimeConfig)
  // Stripped first: a baseline without the field over marked lines would promote the marks.
  if (
    stripped !== runtimeConfig &&
    !writeFileAtomicallyIfUnchanged(join(runtimeHomePath, 'config.toml'), runtimeConfig, stripped, {
      mode: 0o600
    })
  ) {
    return
  }
  const settings = new Map(baseline.settings)
  for (const [key, { system }] of carry.settings) {
    settings.set(key, system)
  }
  const registrations = new Map(baseline.registrations)
  for (const { promotion, system } of carry.registrations) {
    if (promotion.kind === 'append') {
      // Untracked, so the table the distro lacks counts as a tab addition again.
      registrations.delete(promotion.key)
    } else if (promotion.field === 'enabled') {
      const fields = new Map(registrations.get(promotion.key))
      if (system === null) {
        fields.delete('enabled')
      } else {
        fields.set('enabled', system)
      }
      registrations.set(promotion.key, fields)
    }
  }
  writeCodexSettingsBaseline(runtimeHomePath, {
    ...baseline,
    settings,
    registrations,
    guestCarryForward: undefined
  })
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
