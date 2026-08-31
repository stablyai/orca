import type { CliRuntimeUnreachableReason, CliStatusResult } from '../../shared/runtime-types'

// Why (STA-3969): the rule this enforces is that every clause names the observation it came
// from. `unreachableReason` is produced in exactly one place -- the branch that checked the pid
// and found the process alive -- so its presence is what licenses saying the process is running,
// and its absence forbids it. A reason from an earlier poll is reported as history, tense marked,
// never folded into the live verdict.
export function describeOpenTimeout(
  latest: CliStatusResult,
  lastObservedReason: CliRuntimeUnreachableReason | undefined
): string {
  const current = latest.runtime.unreachableReason
  if (current) {
    // A rejected request is an answer, so it cannot also be described as unreachable.
    return current.code === 'request_rejected'
      ? `: the Orca runtime answered but refused the status request. ${current.message}`
      : `: the Orca app process is running but its runtime is unreachable. ${current.message}`
  }
  if (latest.runtime.reachable) {
    return '. The Orca runtime is responding and still running headlessly; it did not open a window in time.'
  }
  if (latest.app.running) {
    return '. The runtime may still be running headlessly.'
  }
  const state =
    latest.runtime.state === 'stale_bootstrap'
      ? '. The Orca app process is no longer running.'
      : '. No Orca runtime is running.'
  return lastObservedReason
    ? `${state} The last failure it reported was: ${lastObservedReason.message}`
    : state
}
