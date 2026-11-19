import { join } from 'node:path'
import { reportCodexHistoryCleanupOnce } from '../../../telemetry/codex-history-cleanup-telemetry'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'
import { codexHistoryCleanupSweepPolicy } from '../cleanup-policy/codex-history-cleanup-policy-live-update'
import { cleanUpCodexHistoryLeftBehind } from './codex-account-history-cleanup'
import {
  checkCodexHistoryLeftBehind,
  type ReportModeMemory
} from './codex-account-history-content-check'
import { recordReportSweep, wasReportSwept } from './codex-history-cleanup-report-sweeps'
import { CleanupBudget, describeCleanupSweep } from './codex-history-cleanup-sweep-tally'

// The content check may spend this share of each limit, so a sweep it cuts short still tallies.
const CONTENT_CHECK_SHARE = 0.7

/** Checks what the home left behind, then deletes (or reports) what the finished check proved. */
export async function checkThenCleanUpCodexHistory(args: {
  accountHome: string
  storeHome: string
  shouldStop: () => boolean
}): Promise<boolean> {
  // Linux (WSL included) can't tell whether an old Codex still writes a copy, so none is deleted
  // there, and checking their content would only cost reads.
  if (process.platform === 'linux') {
    return true
  }
  const policy = await codexHistoryCleanupSweepPolicy()
  const modes = { rollouts: policy.rollouts.mode, databases: policy.databases.mode }
  if (modes.rollouts === 'off' && modes.databases === 'off') {
    return true
  }
  const markerDir = join(getOrcaUserDataPath(), 'codex-account-history')
  // Report mode saves nothing, so it reports each home once per revision instead of every launch.
  const reportOnly = modes.rollouts !== 'enforce' && modes.databases !== 'enforce'
  const reportSweep = {
    markerPath: join(markerDir, 'cleanup-report-swept.json'),
    revision: policy.revision,
    accountHome: args.accountHome
  }
  if (reportOnly && (await wasReportSwept(reportSweep))) {
    return true
  }
  // Once asked to stop, the run is unfinished even if the pass that asked has ended by the time it
  // returns: whatever it skipped is owed again rather than settled for this run.
  let stopped = false
  const shouldStop = (): boolean => (stopped ||= args.shouldStop())
  // One budget for the whole sweep: what it leaves undone waits for the next run's sweep.
  const budget = new CleanupBudget()
  // Report mode keeps this sweep's inventory and checks to itself, so it never changes what a later
  // enforce deletes.
  const report: ReportModeMemory | undefined =
    modes.rollouts === 'enforce' ? undefined : { rollouts: null, checks: new Map() }
  // The content check proves only rollouts. One it cuts short still leads to a tally of what it
  // did check, marked truncated (`budgetHit`); the rest is owed to a later run.
  budget.limitTo(CONTENT_CHECK_SHARE)
  if (
    modes.rollouts !== 'off' &&
    !(await checkCodexHistoryLeftBehind({ ...args, shouldStop, budget, report }))
  ) {
    return false
  }
  budget.limitTo(1)
  const result = await cleanUpCodexHistoryLeftBehind({
    ...args,
    shouldStop,
    now: Date.now(),
    policy,
    budget,
    report
  })
  if (result.rollouts.candidates + result.databases.candidates > 0) {
    console.info(
      `[codex-account-history] Cleanup of ${args.accountHome}: ${describeCleanupSweep(modes, result)}`
    )
  }
  if (shouldStop()) {
    return false
  }
  // A sweep the policy stopped partway speaks for neither its old mode nor the new one.
  if (result.policyChanged) {
    return true
  }
  // Report mode saves no checks, so a retry of a cut-short sweep would only redo the same batch.
  if (reportOnly) {
    await recordReportSweep(reportSweep)
  }
  await reportCodexHistoryCleanupOnce({
    markerPath: join(markerDir, 'cleanup-telemetry-sent.json'),
    revision: policy.revision,
    modes,
    result
  }).catch(() => {})
  return true
}
