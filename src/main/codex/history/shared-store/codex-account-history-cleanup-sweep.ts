import { join } from 'node:path'
import { reportCodexHistoryCleanupOnce } from '../../../telemetry/codex-history-cleanup-telemetry'
import { getOrcaUserDataPath } from '../../configuration/homes/codex-home-paths'
import { codexHistoryCleanupSweepPolicy } from '../cleanup-policy/codex-history-cleanup-policy-live-update'
import { cleanUpCodexHistoryLeftBehind } from './codex-account-history-cleanup'
import { checkCodexHistoryLeftBehind } from './codex-account-history-content-check'
import { CleanupBudget, describeCleanupSweep } from './codex-history-cleanup-sweep-tally'

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
  // Once asked to stop, the run is unfinished even if the pass that asked has ended by the time it
  // returns: whatever it skipped is owed again rather than settled for this run.
  let stopped = false
  const shouldStop = (): boolean => (stopped ||= args.shouldStop())
  // One budget for the whole sweep: what it leaves undone waits for the next run's sweep.
  const budget = new CleanupBudget()
  // The content check proves only rollouts.
  if (
    modes.rollouts !== 'off' &&
    !(await checkCodexHistoryLeftBehind({ ...args, shouldStop, budget }))
  ) {
    return false
  }
  // Checks still owed make any tally partial: the sweep stops there, its progress saved.
  if (budget.ranOut) {
    console.info(
      `[codex-account-history] Cleanup of ${args.accountHome}: budget reached while checking`
    )
    return true
  }
  const result = await cleanUpCodexHistoryLeftBehind({
    ...args,
    shouldStop,
    now: Date.now(),
    policy,
    budget
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
  await reportCodexHistoryCleanupOnce({
    markerPath: join(getOrcaUserDataPath(), 'codex-account-history', 'cleanup-telemetry-sent.json'),
    revision: policy.revision,
    modes,
    result
  }).catch(() => {})
  return true
}
