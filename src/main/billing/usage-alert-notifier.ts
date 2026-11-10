// Desktop notification when the team crosses 75%, 90% or 100% of its included sandbox hours.
// Main owns the decision so every window shares one ledger: a reload, a re-render or a second
// window reading billing never repeats an alert. Levels reset when the billing period rolls over.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OrcaBillingEntitlement } from '../../shared/orca-billing'
import { decideUsageAlert, type UsageAlertLedger } from '../../shared/orca-billing-usage-alerts'

const LEDGER_FILE = 'orca-billing-usage-alerts.json'
/** Accounts kept in the ledger; the oldest drop first (a desktop rarely sees more than a few). */
const MAX_ACCOUNTS = 50

export const USAGE_ALERT_TITLE = 'Orca Cloud'

export type UsageAlertDeps = {
  userDataPath: string
  /** The user's global desktop-notification switch. */
  notificationsEnabled: () => boolean
  body: (percent: number) => string
  show: (input: { title: string; body: string }) => void
}

function ledgerPath(userDataPath: string): string {
  return join(userDataPath, LEDGER_FILE)
}

export function readUsageAlertLedger(userDataPath: string): UsageAlertLedger {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ledgerPath(userDataPath), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const ledger: UsageAlertLedger = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { periodStart?: unknown; levels?: unknown }
      if (
        typeof entry?.periodStart === 'number' &&
        Array.isArray(entry.levels) &&
        entry.levels.every((level) => typeof level === 'number')
      ) {
        ledger[key] = { periodStart: entry.periodStart, levels: entry.levels as number[] }
      }
    }
    return ledger
  } catch {
    return {}
  }
}

function writeUsageAlertLedger(userDataPath: string, ledger: UsageAlertLedger): void {
  const entries = Object.entries(ledger)
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_ACCOUNTS)))
  const path = ledgerPath(userDataPath)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(kept), { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Records and shows the alert for a fresh billing read, if it crosses a new level. Synchronous
 * read-decide-write, so two reads answering back to back can't both notify.
 * Returns the level notified, or null.
 */
export function notifyUsageAlertIfDue(
  accountKey: string,
  entitlement: OrcaBillingEntitlement,
  deps: UsageAlertDeps
): number | null {
  const ledger = readUsageAlertLedger(deps.userDataPath)
  const decision = decideUsageAlert(ledger, accountKey, entitlement)
  if (!decision.notify) {
    return null
  }
  try {
    // Move the account to the end so pruning drops the least recently alerted ones.
    const { [accountKey]: entry, ...rest } = decision.ledger
    writeUsageAlertLedger(deps.userDataPath, { ...rest, [accountKey]: entry })
  } catch {
    // Without a durable record the alert could repeat on every read; skip it this time.
    return null
  }
  // Notifications switched off: the level still counts as handled, so turning them on later
  // doesn't replay a stale alert. The in-app notice still shows it.
  if (!deps.notificationsEnabled()) {
    return null
  }
  deps.show({ title: USAGE_ALERT_TITLE, body: deps.body(decision.notify.percent) })
  return decision.notify.level
}
