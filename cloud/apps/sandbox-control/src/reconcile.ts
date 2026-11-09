// Cron pass: the control plane, not the desktop, guarantees metering, the session deadline and cleanup,
// so a closed laptop or a crash mid-call can never leave a sandbox billed-but-untracked.
import { STOP_RUNNING_REASONS } from './entitlements'
import {
  destroySandbox,
  failAndRelease,
  markProviderStopped,
  refreshGitCredentials,
  suspendAccountRunning,
  sessionFields,
  suspendSandbox,
  type LifecycleDeps
} from './lifecycle'
import { listByStatus, transition, type SandboxRow } from './store'
import { flushUsage, queueUsage } from './usage'

const STUCK_MS = 15 * 60_000
/** The desktop rolls over at the deadline; the cron steps in only if it did not (provider cap is +10 min). */
const FORCED_STOP_GRACE_MS = 5 * 60_000

export type ReconcileSummary = Record<
  | 'settled'
  | 'suspendedForDeadline'
  | 'suspendedForBilling'
  | 'leaseLapsed'
  | 'released'
  | 'repaired'
  | 'billingErrors',
  number
>

export async function reconcile(deps: LifecycleDeps): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    settled: 0,
    suspendedForDeadline: 0,
    suspendedForBilling: 0,
    leaseLapsed: 0,
    released: 0,
    repaired: 0,
    billingErrors: 0
  }
  const polled = await guard(async () => {
    for (const accountId of await deps.entitlements.listSuspensions()) {
      summary.suspendedForBilling += await suspendAccountRunning(deps, accountId)
    }
  })
  if (!polled) {
    summary.billingErrors++
  }
  for (const row of await listByStatus(deps.db, ['running'])) {
    await guard(() => reconcileRunning(deps, row, summary))
  }
  const now = deps.now()
  for (const row of await listByStatus(deps.db, ['creating', 'failed', 'destroying', 'suspending', 'resuming'])) {
    if (now - row.updated_at < STUCK_MS) {
      continue
    }
    await guard(async () => {
      if (row.status === 'creating') {
        await failAndRelease(deps, row)
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
  await flushUsage(deps.db, deps.entitlements, deps.now())
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
  if (row.lease_expires_at !== null && now >= row.lease_expires_at) {
    const state = await deps.provider.getSandbox(row.provider_name, { resume: false })
    if (!state || state.session.status !== 'running') {
      await markProviderStopped(deps, row)
      summary.leaseLapsed++
      return
    }
  }
  if (row.github_token_expires_at !== null && row.session_id && row.github_token_expires_at - now < 15 * 60_000) {
    const git = await refreshGitCredentials(deps, row, row.session_id)
    const refreshed = await transition(deps.db, row, { github_token_expires_at: git?.expiresAt ?? null }, now)
    row = refreshed ?? row
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
