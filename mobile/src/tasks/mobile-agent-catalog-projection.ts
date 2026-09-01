// Why: the mobile agent picker sources its rows from the host's env-free synced
// catalog when it is available (dynamic customs), and falls back to the static
// built-in tables when the catalog is unavailable or its projection is oversize.
// Custom rows appear directly below their base harness and never carry an env key
// or value (the synced DTO is env-free by construction). Selecting a custom is
// only safe once a capable host can derive the launch command from identity
// alone, so customs stay out of the rows until that flip via `includeCustomAgents`.
import type { BuiltInTuiAgent, TuiAgent } from '../../../src/shared/types'
import type { AgentCatalogSnapshot } from '../../../src/shared/agent-catalog-snapshot'
import type { AgentCatalogValue } from '../transport/agent-catalog-sync'
import { MOBILE_AGENT_CATALOG } from './mobile-agent-catalog'

// One selectable picker row. Built-in rows carry their static label/favicon; custom
// rows carry the host label and render with their base harness icon (`baseAgent`).
export type MobileAgentPickerRow = {
  id: TuiAgent
  label: string
  faviconDomain?: string
  isCustom: boolean
  // Present only on custom rows: the base harness whose icon the row shows.
  baseAgent?: BuiltInTuiAgent
}

export type MobileAgentPickerOptions = {
  // Gate for the identity-launch flip: until a capable host can derive the launch
  // command from identity alone, a legacy custom-id launch is host-rejected, so
  // keep customs out of the rows. Built-in rows are unaffected.
  includeCustomAgents?: boolean
}

function isCatalogSnapshot(value: AgentCatalogValue | null): value is AgentCatalogSnapshot {
  // The oversize projection error carries `code` and no `customAgents`; the full
  // snapshot carries `customAgents`. Falling back on either keeps the picker at
  // built-in-only rows rather than a blank list.
  return value != null && 'customAgents' in value
}

function builtInPickerRows(): MobileAgentPickerRow[] {
  return MOBILE_AGENT_CATALOG.map((entry) => ({
    id: entry.id,
    label: entry.label,
    ...(entry.faviconDomain ? { faviconDomain: entry.faviconDomain } : {}),
    isCustom: false
  }))
}

function groupEnabledReadyCustoms(
  snapshot: AgentCatalogSnapshot,
  disabled: ReadonlySet<TuiAgent>
): Map<TuiAgent, MobileAgentPickerRow[]> {
  const grouped = new Map<TuiAgent, MobileAgentPickerRow[]>()
  for (const custom of snapshot.customAgents) {
    // Repair-required customs are not launchable and disabled ones are hidden; a
    // custom whose base harness is disabled is host-rejected at admission
    // (base-disabled), so none of them belongs in the mobile launch picker.
    if (custom.status !== 'ready' || disabled.has(custom.id) || disabled.has(custom.baseAgent)) {
      continue
    }
    const row: MobileAgentPickerRow = {
      id: custom.id,
      label: custom.label,
      isCustom: true,
      baseAgent: custom.baseAgent
    }
    const existing = grouped.get(custom.baseAgent)
    if (existing) {
      existing.push(row)
    } else {
      grouped.set(custom.baseAgent, [row])
    }
  }
  return grouped
}

/** True while the host's agent catalog is fail-closed pending recovery (failed
 *  pre-v1 backup): catalog edits are read-only ON THE HOST and customs are
 *  absent. Boolean projection only — the error detail never crosses the wire. */
export function isHostAgentCatalogMigrationBlocked(snapshot: AgentCatalogValue | null): boolean {
  return isCatalogSnapshot(snapshot) && snapshot.migrationBlocked === true
}

/** Picker subtitle for a blocked host, or undefined when healthy. */
export function hostAgentCatalogReadOnlyNotice(
  snapshot: AgentCatalogValue | null
): string | undefined {
  return isHostAgentCatalogMigrationBlocked(snapshot)
    ? 'Agent settings on this host are read-only until its data migration is recovered.'
    : undefined
}

/** Build the ordered picker rows. With no usable snapshot or with customs gated
 *  off, returns exactly the static built-in rows. Otherwise each enabled, ready
 *  custom is inserted directly below its base harness in the built-in order. */
export function buildMobileAgentPickerRows(
  snapshot: AgentCatalogValue | null,
  options: MobileAgentPickerOptions = {}
): MobileAgentPickerRow[] {
  if (!isCatalogSnapshot(snapshot)) {
    return builtInPickerRows()
  }
  // Why: the snapshot's disabledAgents is the same host state the launch
  // admission checks, so a disabled base harness must not be offered — selecting
  // it is rejected on the host. Without a snapshot the callers' settings-based
  // filter is the only guard.
  const disabled = new Set<TuiAgent>(snapshot.disabledAgents)
  const builtInRows = builtInPickerRows().filter((row) => !disabled.has(row.id))
  if (!options.includeCustomAgents) {
    return builtInRows
  }
  const customsByBase = groupEnabledReadyCustoms(snapshot, disabled)
  if (customsByBase.size === 0) {
    return builtInRows
  }
  const rows: MobileAgentPickerRow[] = []
  for (const builtIn of builtInRows) {
    rows.push(builtIn)
    const customs = customsByBase.get(builtIn.id)
    if (customs) {
      rows.push(...customs)
    }
  }
  return rows
}
