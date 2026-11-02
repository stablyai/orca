import { tuiAgentDisplayName } from '../../../shared/tui-agent-display-names'
import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import { DEFAULT_WAIT_TIMEOUT_SECONDS } from '../../../shared/setup-agent-sequencing'
import { createSetupCompletionScanner } from '../orchestration/setup-completion-signal'
import { subscribeToPtyEndpointLoss } from '../terminal/pty-endpoint-loss-signal'

export type SetupRunOutcome =
  | { kind: 'succeeded' }
  | { kind: 'failed'; exitCode: number }
  | {
      kind: 'ended'
      reason: 'preparation_failed' | 'spawn_failed' | 'closed' | 'observation_lost' | 'deadline'
    }

export type SetupRun = {
  waitsForAgent: boolean
  outcome: Promise<SetupRunOutcome>
  result: SetupRunOutcome | undefined
  settle: (outcome: SetupRunOutcome) => void
  onSettled: (cleanup: () => void) => void
}

export function createSetupRun(waitsForAgent: boolean): SetupRun {
  let resolve!: (result: SetupRunOutcome) => void
  const cleanups: (() => void)[] = []
  const run: SetupRun = {
    waitsForAgent,
    outcome: new Promise((complete) => {
      resolve = complete
    }),
    result: undefined,
    settle(result) {
      if (run.result) {
        return
      }
      run.result = result
      for (const cleanup of cleanups.splice(0)) {
        cleanup()
      }
      resolve(result)
    },
    onSettled(cleanup) {
      if (run.result) {
        cleanup()
      } else {
        cleanups.push(cleanup)
      }
    }
  }
  const deadline = setTimeout(
    () => run.settle({ kind: 'ended', reason: 'deadline' }),
    DEFAULT_WAIT_TIMEOUT_SECONDS * 1000
  )
  deadline.unref?.()
  run.onSettled(() => clearTimeout(deadline))
  return run
}

export function bindSetupRunToPty(
  run: SetupRun,
  ptyId: string,
  token: string,
  host: {
    subscribeToData: (ptyId: string, listener: (data: string) => void) => () => void
    subscribeToExit: (ptyId: string, listener: () => void) => () => void
  }
): void {
  const scanner = createSetupCompletionScanner(token, (exitCode) =>
    run.settle(exitCode === 0 ? { kind: 'succeeded' } : { kind: 'failed', exitCode })
  )
  try {
    run.onSettled(host.subscribeToData(ptyId, scanner.scan))
    run.onSettled(
      host.subscribeToExit(ptyId, () => run.settle({ kind: 'ended', reason: 'closed' }))
    )
    run.onSettled(
      subscribeToPtyEndpointLoss(ptyId, () =>
        run.settle({ kind: 'ended', reason: 'observation_lost' })
      )
    )
  } catch {
    run.settle({ kind: 'ended', reason: 'observation_lost' })
  }
}

export class AgentLaunchSetupNotCompletedError extends Error {
  readonly code = 'agent_launch_setup_not_completed'
  constructor(
    readonly outcome: SetupRunOutcome,
    agent: string
  ) {
    const name = tuiAgentDisplayName(agent) ?? agent
    const reason =
      outcome.kind === 'failed'
        ? 'Setup failed'
        : outcome.kind === 'ended'
          ? {
              preparation_failed: 'The setup script could not be prepared',
              spawn_failed: 'Setup could not start',
              closed: 'Setup was closed before it finished',
              observation_lost: 'Orca could not confirm that Setup finished',
              deadline: 'Setup did not finish in time'
            }[outcome.reason]
          : 'Setup could not be completed'
    super(
      `${reason}, so ${name} was not started. Fix or rerun the setup script, then start ${name} in this workspace.`
    )
    this.name = 'AgentLaunchSetupNotCompletedError'
  }
}

export async function awaitRequiredSetup(
  run: SetupRun | undefined,
  agent: string,
  signal?: AbortSignal
): Promise<void> {
  if (!run?.waitsForAgent) {
    return
  }
  const outcome = await waitForPromiseWithSignal(run.outcome, signal)
  if (outcome.kind !== 'succeeded') {
    throw new AgentLaunchSetupNotCompletedError(outcome, agent)
  }
}

/** Settled results kept for late consumers; live runs are never evicted, since each ends by its own deadline. */
const SETTLED_SETUP_RUN_HISTORY = 256

export class SetupRunRegistry {
  private readonly live = new Map<string, SetupRun>()
  private readonly settled = new Map<string, SetupRun>()

  readonly register = (worktreeId: string, run: SetupRun): void => {
    this.settled.delete(worktreeId)
    this.live.set(worktreeId, run)
    run.onSettled(() => {
      if (this.live.get(worktreeId) !== run) {
        return
      }
      this.live.delete(worktreeId)
      this.settled.set(worktreeId, run)
      if (this.settled.size > SETTLED_SETUP_RUN_HISTORY) {
        const oldest = this.settled.keys().next().value
        if (oldest !== undefined) {
          this.settled.delete(oldest)
        }
      }
    })
  }

  readonly get = (worktreeId: string): SetupRun | undefined =>
    this.live.get(worktreeId) ?? this.settled.get(worktreeId)

  readonly forget = (worktreeId: string): void => {
    this.live.get(worktreeId)?.settle({ kind: 'ended', reason: 'closed' })
    this.live.delete(worktreeId)
    this.settled.delete(worktreeId)
  }
}
