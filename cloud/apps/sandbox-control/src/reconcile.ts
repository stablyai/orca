import { PlatformHostSuffixesConfigError } from './network-policy'
// Cron pass: the control plane, not the desktop, guarantees metering, the session deadline and cleanup,
// so a closed laptop or a crash mid-call can never leave a sandbox billed-but-untracked.
import { STOP_RUNNING_REASONS } from './entitlements'
import {
  destroySandbox,
  failAndRelease,
  markProviderStopped,
  refreshGitCredentials,
  renewLease,
  suspendAccountRunning,
  sessionFields,
  suspendSandbox,
  type LifecycleDeps
} from './lifecycle'
import { guardrails } from './lifecycle'
import { killSwitchOn } from './guardrails'
import { drainAll, housekeeping, openHold, type HousekeepingSummary } from './retention'
import { CREATE_ABANDONED_MS, listByStatus, transition, type SandboxRow } from './store'
import { flushUsage, queueUsage } from './usage'
import { expiredArchives } from './workspace-lifecycle'
import { ACTIVITY_CHECK_BEFORE_LAPSE_MS, ACTIVITY_RENEW_MS, decideFromActivity, readVmActivity } from './vm-activity'

const STUCK_MS = 15 * 60_000
/**
 * A create's longest legitimate run is a 30 s pooled try, a VM create and the 120 s start command.
 * Past this its Worker was cut off (the desktop gave up or disconnected): fail it and free the VM
 * instead of leaving a billed 'creating' row for the full STUCK_MS. The start gate stops counting it then too.
 */
export const CREATE_STUCK_MS = CREATE_ABANDONED_MS
/** The desktop rolls over at the deadline; the cron steps in only if it did not (provider cap is +10 min). */
const FORCED_STOP_GRACE_MS = 5 * 60_000

export type ReconcileSummary = Record<
  | 'drained'
  | 'settled'
  | 'suspendedForDeadline'
  | 'suspendedForBilling'
  | 'leaseLapsed'
  | 'activityRenewed'
  | 'idleSlept'
  | 'released'
  | 'repaired'
  | 'archivesExpired'
  | 'billingErrors',
  number
> & { housekeeping?: HousekeepingSummary }

export async function reconcile(deps: LifecycleDeps): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    drained: 0,
    settled: 0,
    suspendedForDeadline: 0,
    suspendedForBilling: 0,
    leaseLapsed: 0,
    activityRenewed: 0,
    idleSlept: 0,
    released: 0,
    repaired: 0,
    archivesExpired: 0,
    billingErrors: 0
  }
  const polled = await guard(async () => {
    for (const accountId of await deps.entitlements.listSuspensions()) {
      summary.suspendedForBilling += await suspendAccountRunning(deps, accountId)
      // Payment grace expired: the data-retention clock starts (no-op if already running).
      await openHold(deps.db, accountId, 'payment_grace_expired', deps.now())
    }
  })
  if (!polled) {
    summary.billingErrors++
  }
  if (await killSwitchOn(deps.db, guardrails(deps))) {
    // Kill switch on: keep draining until nothing runs (a drain call may have timed out mid-way).
    await guard(async () => {
      summary.drained += (await drainAll(deps)).suspended
    })
  }
  for (const row of await listByStatus(deps.db, ['running'])) {
    await guard(() => reconcileRunning(deps, row, summary))
  }
  const now = deps.now()
  for (const row of await listByStatus(deps.db, ['creating', 'failed', 'destroying', 'suspending', 'resuming'])) {
    if (now - row.updated_at < (row.status === 'creating' ? CREATE_STUCK_MS : STUCK_MS)) {
      continue
    }
    await guard(async () => {
      if (row.status === 'creating') {
        await failAndRelease(deps, row, 'create_abandoned')
        summary.released++
      } else if (row.status === 'failed' || row.status === 'destroying') {
        await destroySandbox(deps, row)
        summary.released++
      } else {
        await repairTransition(deps, row)
        summary.repaired++
      }
    })
  }
  for (const row of await expiredArchives(deps.db, deps.now())) {
    await guard(async () => {
      await destroySandbox(deps, row)
      summary.archivesExpired++
    })
  }
  await flushUsage(deps.db, deps.entitlements, deps.now())
  await guard(async () => {
    const housekept = await housekeeping(deps)
    if (housekept.swept) {
      summary.housekeeping = housekept
    }
  })
  return summary
}

async function reconcileRunning(deps: LifecycleDeps, row: SandboxRow, summary: ReconcileSummary): Promise<void> {
  const now = deps.now()
  if (row.session_deadline_at !== null && now >= row.session_deadline_at + FORCED_STOP_GRACE_MS) {
    // No desktop rolled it over; stop before the provider's hard cap kills it undrained.
    await suspendSandbox(deps, row)
    summary.suspendedForDeadline++
    return
  }
  if (leaseLapsingSoon(row, now)) {
    // The desktop may be closed: the VM's own activity decides, not whether anyone renewed.
    const decision = decideFromActivity(await readVmActivity(deps.provider, row.session_id!))
    if (decision === 'sleep') {
      await suspendSandbox(deps, row)
      summary.idleSlept++
      return
    }
    if (decision === 'renew' || decision === 'wait') {
      row = await renewLease(deps, row, decision === 'renew' ? ACTIVITY_RENEW_MS : ACTIVITY_CHECK_BEFORE_LAPSE_MS + 5 * 60_000)
      summary.activityRenewed++
    }
  }
  if (row.lease_expires_at !== null && now >= row.lease_expires_at) {
    const state = await deps.provider.getSandbox(row.provider_name, { resume: false })
    if (!state || state.session.status !== 'running') {
      await markProviderStopped(deps, row)
      summary.leaseLapsed++
      return
    }
  }
  if (row.github_token_expires_at !== null && row.session_id && row.github_token_expires_at - now < 15 * 60_000) {
    // A malformed ORCA_PLATFORM_HOST_SUFFIXES leaves the live policy as it is; usage still settles below.
    const git = await refreshGitCredentials(deps, row, row.session_id).catch((error: unknown) => {
      if (error instanceof PlatformHostSuffixesConfigError) {
        return 'skipped' as const
      }
      throw error
    })
    if (git !== 'skipped') {
      const refreshed = await transition(deps.db, row, { github_token_expires_at: git?.expiresAt ?? null }, now)
      row = refreshed ?? row
    }
  }
  const settled = await queueUsage(deps.db, row, now)
  const current = settled === row.usage_settled_at ? row : await transition(deps.db, row, { usage_settled_at: settled }, now)
  summary.settled++
  const answer = await flushUsage(deps.db, deps.entitlements, now, row.id)
  if (answer?.suspendRunning) {
    summary.suspendedForBilling += await suspendAccountRunning(deps, row.account_id)
  } else if (current && answer && !answer.canStartSandbox && STOP_RUNNING_REASONS.has(answer.reason ?? '')) {
    await suspendSandbox(deps, current)
    summary.suspendedForBilling++
  }
}

function leaseLapsingSoon(row: SandboxRow, now: number): boolean {
  return (
    row.session_id !== null &&
    row.lease_expires_at !== null &&
    now < row.lease_expires_at &&
    row.lease_expires_at - now <= ACTIVITY_CHECK_BEFORE_LAPSE_MS &&
    (row.session_deadline_at === null || row.lease_expires_at < row.session_deadline_at)
  )
}

/** A suspend/resume call died mid-way: adopt whatever the provider says is true. */
async function repairTransition(deps: LifecycleDeps, row: SandboxRow): Promise<void> {
  const state = await deps.provider.getSandbox(row.provider_name, { resume: false })
  if (state?.session.status === 'running') {
    await transition(deps.db, row, { status: 'running', ...sessionFields(deps, state) }, deps.now())
    return
  }
  await markProviderStopped(deps, row)
}

async function guard(step: () => Promise<void>): Promise<boolean> {
  try {
    await step()
    return true
  } catch {
    // One bad row must not stall the pass; it is retried next tick.
    return false
  }
}
