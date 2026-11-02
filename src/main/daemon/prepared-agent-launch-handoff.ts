import type { LaunchWork } from './prepared-agent-launch-execution'
import type {
  PreparedAgentLaunchStatus,
  PreparedTerminalPrompts
} from './prepared-agent-launch-protocol'
import type {
  PreparedLaunchInputOutcome,
  PreparedPromptConsumer
} from '../../shared/prepared-agent-launch'

export function snapshotPreparedLaunch(work: LaunchWork): PreparedAgentLaunchStatus {
  return structuredClone(work.status)
}

/**
 * The daemon is the only fence for the first prompt. Reading it is repeatable; the attempt is
 * granted once per operation, to whichever request asks first, and every later request (same
 * process included) gets the status with its outstanding attempt or terminal receipt instead.
 */
export async function claimPreparedPrompt(
  work: LaunchWork,
  consumer: PreparedPromptConsumer,
  attempt: string | undefined,
  deps: { isGone: (consumer: PreparedPromptConsumer) => Promise<boolean>; notify: () => void }
): Promise<{ prompts: PreparedTerminalPrompts } | PreparedAgentLaunchStatus> {
  const held = work.promptAttempt
  if (held && held.consumer.id !== consumer.id && work.status.input === undefined) {
    // A new caller is not proof the writer died; only its process demise settles as uncertain.
    if ((await deps.isGone(held.consumer)) && work.promptAttempt === held) {
      settlePreparedPrompt(work, 'uncertain')
      deps.notify()
    }
  }
  if (!work.status.published || !work.prompts || work.promptAttempt) {
    return snapshotPreparedLaunch(work)
  }
  if (attempt) {
    work.promptAttempt = { request: attempt, consumer }
  }
  return { prompts: structuredClone(work.prompts) }
}

/** Only the winning request settles; the receipt is final and never reopens a delivery. */
export function settlePreparedAttempt(
  work: LaunchWork,
  attempt: string,
  outcome: PreparedLaunchInputOutcome
): boolean {
  if (work.status.input !== undefined || work.promptAttempt?.request !== attempt) {
    return false
  }
  settlePreparedPrompt(work, outcome)
  return true
}

/** Every handoff outcome is terminal: the payload dies and its result never authorizes a resend. */
export function settlePreparedPrompt(work: LaunchWork, outcome: PreparedLaunchInputOutcome): void {
  work.status.input = outcome
  work.prompts = undefined
  work.promptAttempt = undefined
}

export function waitForPreparedLaunch(
  work: LaunchWork,
  requestedMs: number,
  until: 'setup' | 'launch' = 'launch'
): Promise<PreparedAgentLaunchStatus> {
  const ready = () =>
    (until === 'setup' && work.status.setup?.incarnationId !== undefined) ||
    (work.status.execution !== 'not-dispatched' && work.status.execution !== 'dispatching')
  if (ready()) {
    return Promise.resolve(snapshotPreparedLaunch(work))
  }
  return new Promise((resolve) => {
    const done = () => {
      if (!ready()) {
        return
      }
      finish()
    }
    const finish = () => {
      clearTimeout(timer)
      work.changed.delete(done)
      resolve(snapshotPreparedLaunch(work))
    }
    const timer = setTimeout(finish, Math.max(1, Math.min(10_000, requestedMs)))
    work.changed.add(done)
  })
}
