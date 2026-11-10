// Desktop notification when the team crosses 75%, 90% or 100% of its included sandbox hours.
// Main owns the decision so every window shares one ledger: a reload, a re-render or a second
// window reading billing never repeats an alert. Levels reset when the billing period rolls over.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { OrcaBillingEntitlement } from '../../shared/orca-billing'
import { decideUsageAlert, type UsageAlertLedger } from '../../shared/orca-billing-usage-alerts'

const LEDGER_FILE = 'orca-billing-usage-alerts.json'
/** Accounts kept in the ledger; the oldest drop first (a desktop rarely sees more than a few). */
const MAX_ACCOUNTS = 50

export const USAGE_ALERT_TITLE = 'Orca Cloud'

const LedgerSchema = z.record(
  z.string(),
  z.object({ periodStart: z.number(), levels: z.array(z.number()) })
)

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

export async function readUsageAlertLedger(userDataPath: string): Promise<UsageAlertLedger> {
  try {
    const parsed = LedgerSchema.safeParse(
      JSON.parse(await readFile(ledgerPath(userDataPath), 'utf8'))
    )
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

async function writeUsageAlertLedger(
  userDataPath: string,
  ledger: UsageAlertLedger
): Promise<void> {
  const entries = Object.entries(ledger)
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_ACCOUNTS)))
  const path = ledgerPath(userDataPath)
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(kept), { mode: 0o600 })
  await rename(tmp, path)
}

/** One read-decide-write at a time, so two reads answering back to back can't both notify. */
let queue: Promise<unknown> = Promise.resolve()

/**
 * Records and shows the alert for a fresh billing read, if it crosses a new level.
 * Resolves to the level notified, or null.
 */
export function notifyUsageAlertIfDue(
  accountKey: string,
  entitlement: OrcaBillingEntitlement,
  deps: UsageAlertDeps
): Promise<number | null> {
  const run = queue.then(() => decideAndNotify(accountKey, entitlement, deps))
  queue = run.catch(() => null)
  return run
}

async function decideAndNotify(
  accountKey: string,
  entitlement: OrcaBillingEntitlement,
  deps: UsageAlertDeps
): Promise<number | null> {
  const ledger = await readUsageAlertLedger(deps.userDataPath)
  const decision = decideUsageAlert(ledger, accountKey, entitlement)
  if (!decision.notify) {
    return null
  }
  try {
    // Move the account to the end so pruning drops the least recently alerted ones.
    const { [accountKey]: entry, ...rest } = decision.ledger
    await writeUsageAlertLedger(deps.userDataPath, { ...rest, [accountKey]: entry })
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
