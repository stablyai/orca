import type {
  PreparedCheckoutOutcome,
  WorktreeCreateExecutionHost,
  WorktreeCreateTiming,
  WorktreeCreateTimingPhase
} from '../shared/worktree/create-types'
import type { WorktreeCreatePhase } from '../shared/worktree/create-timing-vocabulary'
import type { PreparationWork, WorktreeCreateInFlightHandle } from './worktree-create-concurrency'
import { wslDistroForCommand } from './git/command-runner/git-command-resolution'

type TimingClock = () => number

const MAX_CAUSE_DEPTH = 5

export type WorktreeCreateTimingRecorder = {
  time<T>(phase: WorktreeCreatePhase, operation: () => Promise<T>): Promise<T>
  timeSync<T>(phase: WorktreeCreatePhase, operation: () => T): T
  recordPreparedCheckout(outcome: PreparedCheckoutOutcome): void
  /** Exclude the adopted preparation from competing disk work. */
  recordAdoptedPreparation(work: PreparationWork): void
  recordExecutionHost(host: WorktreeCreateExecutionHost): void
  recordWorktreeCount(count: number): void
  /** Outermost failed phase found for this error or its cause chain. */
  failedPhase(error: unknown): WorktreeCreatePhase | undefined
  /** Close concurrency tracking before this create launches replacement work. */
  finish(): WorktreeCreateTiming
}

/** WSL paths execute Git in WSL even without a project runtime. */
export function localWorktreeCreateExecutionHost(gitExecOptions: {
  cwd?: string
  wslDistro?: string
}): WorktreeCreateExecutionHost {
  return wslDistroForCommand(gitExecOptions.cwd, gitExecOptions.wslDistro) ? 'wsl' : 'local'
}

function defaultClock(): number {
  return performance.now()
}

function clampDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function createPhase(
  phase: WorktreeCreatePhase,
  operationStartedAt: number,
  operationEndedAt: number,
  rootStartedAt: number
): WorktreeCreateTimingPhase {
  return {
    phase,
    startedAtMs: clampDuration(operationStartedAt - rootStartedAt),
    durationMs: clampDuration(operationEndedAt - operationStartedAt)
  }
}

export function createWorktreeCreateTimingRecorder(
  clock: TimingClock = defaultClock,
  inFlight?: WorktreeCreateInFlightHandle
): WorktreeCreateTimingRecorder {
  const startedAt = clock()
  const phases: WorktreeCreateTimingPhase[] = []
  let preparedCheckout: PreparedCheckoutOutcome | undefined
  let executionHost: WorktreeCreateExecutionHost | undefined
  let worktreeCount: number | undefined
  // Attribute phases by thrown object so caught failures and concurrent siblings cannot mix.
  const phaseByError = new WeakMap<object, WorktreeCreatePhase>()

  const recordPhase = (phase: WorktreeCreatePhase, operationStartedAt: number): void => {
    phases.push(createPhase(phase, operationStartedAt, clock(), startedAt))
  }
  const recordFailure = (phase: WorktreeCreatePhase, error: unknown): void => {
    // Outer phases settle after inner ones, so overwriting leaves the outermost that rethrew.
    if (typeof error === 'object' && error !== null) {
      phaseByError.set(error, phase)
    }
  }

  return {
    async time<T>(phase: WorktreeCreatePhase, operation: () => Promise<T>): Promise<T> {
      const operationStartedAt = clock()
      try {
        return await operation()
      } catch (error) {
        recordFailure(phase, error)
        throw error
      } finally {
        recordPhase(phase, operationStartedAt)
      }
    },
    timeSync<T>(phase: WorktreeCreatePhase, operation: () => T): T {
      const operationStartedAt = clock()
      try {
        return operation()
      } catch (error) {
        recordFailure(phase, error)
        throw error
      } finally {
        recordPhase(phase, operationStartedAt)
      }
    },
    recordPreparedCheckout(outcome: PreparedCheckoutOutcome): void {
      preparedCheckout = outcome
    },
    recordAdoptedPreparation(work: PreparationWork): void {
      inFlight?.adoptPreparation(work)
    },
    recordExecutionHost(host: WorktreeCreateExecutionHost): void {
      executionHost = host
    },
    recordWorktreeCount(count: number): void {
      worktreeCount = count
    },
    failedPhase(error: unknown) {
      let current = error
      for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
        if (typeof current !== 'object' || current === null) {
          return undefined
        }
        const phase = phaseByError.get(current)
        if (phase) {
          return phase
        }
        current = current instanceof Error ? current.cause : undefined
      }
      return undefined
    },
    finish() {
      inFlight?.end()
      return {
        totalDurationMs: clampDuration(clock() - startedAt),
        phases: [...phases],
        ...(preparedCheckout ? { preparedCheckout } : {}),
        ...(executionHost ? { executionHost } : {}),
        ...(worktreeCount !== undefined ? { worktreeCount } : {})
      }
    }
  }
}
