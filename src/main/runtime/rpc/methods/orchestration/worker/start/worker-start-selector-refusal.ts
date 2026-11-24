import { OrchestrationError } from '../../../../../orchestration/orchestration-error'

/** The worker-start flag whose value named nothing. */
export type WorkerStartFlag = '--worktree' | '--repo' | '--terminal' | '--from'

export type WorkerStartSelectorLabel = {
  flag: WorkerStartFlag
  value: string
  /** What the value should have named, when the flag's own noun would mislead. */
  subject?: string
}

const SUBJECTS: Record<WorkerStartFlag, string> = {
  '--worktree': 'workspace',
  '--repo': 'repo',
  '--terminal': 'terminal',
  '--from': 'terminal'
}

/** Runs before the start is accepted, so a bare not-found names its flag and says nothing started. */
export async function refuseUnmatchedWorkerSelector<T>(
  label: WorkerStartSelectorLabel,
  resolve: () => Promise<T>
): Promise<T> {
  try {
    return await resolve()
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'selector_not_found') {
      throw error
    }
    const { flag, value, subject = SUBJECTS[flag] } = label
    throw new OrchestrationError(
      'selector_not_found',
      `No ${subject} matches ${flag} ${value}. Nothing was started; no effects were applied.`,
      { effectsApplied: false, flag, value }
    )
  }
}

/** The flag that named the worker's workspace or repo; --terminal supplies it when --worktree is absent. */
export function workerStartTargetLabel(args: {
  createsWorktree: boolean
  requestedWorktree: string
  worktree?: string
  repo?: string
  terminal?: string
}): WorkerStartSelectorLabel {
  const { requestedWorktree: value, repo, terminal } = args
  if (args.createsWorktree) {
    return repo
      ? { flag: '--repo', value: repo }
      : { flag: '--worktree', value, subject: "repo for the caller's workspace" }
  }
  return args.worktree || !terminal
    ? { flag: '--worktree', value }
    : { flag: '--terminal', value: terminal, subject: 'workspace for the terminal' }
}
