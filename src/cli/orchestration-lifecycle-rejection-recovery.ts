/**
 * REJECTED_WORKER_DONE_NOT_TERMINAL — a rejected lifecycle message leaves the
 * Dispatch ACTIVE. The worker must be able to tell that apart from an accepted
 * completion and act on it without transcript archaeology, so every rejection
 * carries `dispatchSettled: false` plus the one operation that recovers it.
 *
 * Observed the hard way: a `worker_done` rejected for a missing capability
 * returned only a code and a sentence, which reads like a terminal failure.
 */

export type LifecycleRejectionRecovery = {
  /** Always false: a rejection never settles the Dispatch. */
  dispatchSettled: false
  nextSteps: readonly string[]
}

const RECOVERY: Record<string, readonly string[]> = {
  dispatch_capability_invalid: [
    'This completion was REJECTED and the Dispatch is still active — it is not a terminal failure and the task is not settled.',
    'Re-read the active Dispatch envelope for its exact current capability: `orca orchestration dispatch-show --task <task-id> --from <your-handle> --preamble`.',
    'Resend the same message once with `--dispatch-capability <capability>` from the dispatched pane.',
    'If the envelope carries no capability, send one escalation naming the missing recovery operation instead of resending a rejected completion.'
  ],
  sender_not_assignee: [
    'This completion was REJECTED and the Dispatch is still active.',
    'Only the dispatched pane may settle it: resend from that pane with `--from <dispatch-assignee-handle>`.',
    'Run `orca orchestration dispatch-show --task <task-id> --json` to read the assignee handle and pane key.'
  ],
  task_dispatch_mismatch: [
    'This completion was REJECTED and the Dispatch is still active.',
    'The task id sent does not belong to this Dispatch — a late completion from an earlier attempt cannot settle the current one.',
    'Run `orca orchestration dispatch-show --task <task-id> --json` and resend with that Dispatch’s own `--task-id` and `--dispatch-id`.'
  ]
}

export function lifecycleRejectionRecovery(
  code: string | null | undefined
): LifecycleRejectionRecovery | undefined {
  const steps = code ? RECOVERY[code] : undefined
  return steps ? { dispatchSettled: false, nextSteps: steps } : undefined
}
