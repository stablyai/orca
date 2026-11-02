import { randomUUID } from 'node:crypto'
import { tuiAgentDisplayName } from '../../../../shared/tui-agent-display-names'
import type { PreparedTerminalPrompts } from '../../../daemon/prepared-agent-launch-protocol'
import type {
  PreparedAgentLaunchDescriptor,
  PreparedAgentLaunchIdentity
} from '../../../../shared/prepared-agent-launch'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'

export function preparedPromptUncertainText(agent: string): string {
  const name = tuiAgentDisplayName(agent) ?? agent
  return `${name} started, but its first prompt may not have been delivered. Check ${name} before sending the prompt again.`
}

type PromptContinuation = {
  publish: (terminal: RuntimeTerminalCreate) => void
  answer: Promise<RuntimeTerminalCreate>
}

// Marks a prompt-bearing descriptor; a main that finds it without its continuation was restarted.
const PROMPT_OWNER_REF = randomUUID()
// Post-start input lives only with the main flow that created the launch, as for every startup.
const continuations = new Map<string, PromptContinuation>()

export function preparedLaunchKey(identity: PreparedAgentLaunchIdentity): string {
  return [
    identity.operationId,
    identity.fingerprint,
    identity.daemonGeneration,
    identity.reservationGeneration
  ].join('\0')
}

/**
 * The creating flow installs the one input continuation before acceptance can expose the launch.
 * It writes once, after the exact agent is published; refusal or failure ends it as uncertain.
 */
export function installPreparedPromptContinuation(
  identity: PreparedAgentLaunchIdentity,
  agent: string,
  prompts: PreparedTerminalPrompts,
  deliver: (terminal: RuntimeTerminalCreate, prompts: PreparedTerminalPrompts) => Promise<boolean>
): string {
  const published = Promise.withResolvers<RuntimeTerminalCreate>()
  let owed: PreparedTerminalPrompts | undefined = prompts
  const answer = published.promise.then(async (terminal) => {
    const bytes = owed
    owed = undefined
    // Boolean refusal does not prove nothing was written, so it never permits another attempt.
    const written = bytes ? await deliver(terminal, bytes).catch(() => false) : false
    return written ? terminal : { ...terminal, warning: preparedPromptUncertainText(agent) }
  })
  continuations.set(preparedLaunchKey(identity), { publish: published.resolve, answer })
  return PROMPT_OWNER_REF
}

/**
 * Publication hands the exact agent to its creator and joins the one answer; it never writes.
 * Without a creator, a prompt-bearing launch may have been written before main restarted.
 */
export function joinPreparedPromptContinuation(
  identity: PreparedAgentLaunchIdentity,
  descriptor: PreparedAgentLaunchDescriptor,
  terminal: RuntimeTerminalCreate
): Promise<RuntimeTerminalCreate> {
  const continuation = continuations.get(preparedLaunchKey(identity))
  if (continuation) {
    continuation.publish(terminal)
    return continuation.answer
  }
  return Promise.resolve(
    typeof descriptor.promptOwnerRef === 'string'
      ? { ...terminal, warning: preparedPromptUncertainText(descriptor.claim.agent) }
      : terminal
  )
}

/** Kept until its answer is recorded or the launch is gone, so a failed write retries recording only. */
export function forgetPreparedPromptContinuation(identity: PreparedAgentLaunchIdentity): void {
  continuations.delete(preparedLaunchKey(identity))
}
