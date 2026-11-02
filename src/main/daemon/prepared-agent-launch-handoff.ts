import type { LaunchWork } from './prepared-agent-launch-execution'
import type { PreparedAgentLaunchStatus } from './prepared-agent-launch-protocol'
import type {
  PreparedLaunchInputOutcome,
  PreparedPromptConsumer
} from '../../shared/prepared-agent-launch'

export function snapshotPreparedLaunch(work: LaunchWork): PreparedAgentLaunchStatus {
  return structuredClone(work.status)
}

/** Acquisition is recoverable; only an attempt by a consumer not proven gone fences the prompt. */
export async function claimPreparedPrompt(
  work: LaunchWork,
  consumer: PreparedPromptConsumer,
  attempt: boolean,
  deps: { isGone: (consumer: PreparedPromptConsumer) => Promise<boolean>; notify: () => void }
) {
  if (!work.status.published || !work.prompts) {
    return null
  }
  const held = work.promptConsumer
  if (held && held.id !== consumer.id && work.promptAttempted) {
    // A new caller is not proof the writer died; only its process demise settles as uncertain.
    if (await deps.isGone(held)) {
      settlePreparedPrompt(work, 'uncertain')
      deps.notify()
    }
    return null
  }
  work.promptConsumer = consumer
  if (attempt) {
    work.promptAttempted = true
  }
  return structuredClone(work.prompts)
}

/** Every handoff outcome is terminal: the payload dies and its result never authorizes a resend. */
export function settlePreparedPrompt(work: LaunchWork, outcome: PreparedLaunchInputOutcome): void {
  work.status.input = outcome
  work.prompts = undefined
  work.promptConsumer = undefined
  work.promptAttempted = undefined
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
