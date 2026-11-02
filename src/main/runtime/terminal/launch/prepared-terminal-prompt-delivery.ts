import { randomUUID } from 'node:crypto'
import { tuiAgentDisplayName } from '../../../../shared/tui-agent-display-names'
import type { PreparedTerminalPrompts } from '../../../daemon/prepared-agent-launch-protocol'
import type {
  PreparedAgentLaunchDescriptor,
  PreparedAgentLaunchIdentity
} from '../../../../shared/prepared-agent-launch'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type { AgentSessionOperationRow } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import { PreparedTerminalPendingError } from './prepared-terminal-pending'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'

/** The operation namespace main records prepared worktree launches under. */
export const PREPARED_LAUNCH_ROW_CALLER = 'worktree-startup'

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

/** Only an actual draft or followup is post-start input; an empty bundle owes nothing. */
export function hasPreparedPrompts(
  prompts: PreparedTerminalPrompts | undefined
): prompts is PreparedTerminalPrompts {
  return Boolean(prompts?.draft || prompts?.followup)
}

/**
 * Publication hands the exact agent to its creator and joins the one answer; it never writes.
 * Once the creator is gone, the saved answer is the launch's answer; with none, only a launch
 * an earlier main created may have lost its prompt to the restart, and this main's own launch
 * has no answer an observer can know yet.
 */
export function joinPreparedPromptContinuation(
  identity: PreparedAgentLaunchIdentity,
  descriptor: PreparedAgentLaunchDescriptor,
  terminal: RuntimeTerminalCreate,
  row: () => AgentSessionOperationRow | null
): Promise<RuntimeTerminalCreate> {
  const continuation = continuations.get(preparedLaunchKey(identity))
  if (continuation) {
    continuation.publish(terminal)
    return continuation.answer
  }
  const saved = readPreparedLaunchAnswer(row(), identity, terminal.incarnationId)
  if (saved || typeof descriptor.promptOwnerRef !== 'string') {
    return Promise.resolve(saved?.warning ? { ...terminal, warning: saved.warning } : terminal)
  }
  if (descriptor.promptOwnerRef === PROMPT_OWNER_REF) {
    return Promise.reject(new PreparedTerminalPendingError(identity))
  }
  return Promise.resolve({
    ...terminal,
    warning: preparedPromptUncertainText(descriptor.claim.agent)
  })
}

/** This launch's saved row, by its exact key; one launch never searches the whole ledger. */
export function preparedLaunchRow(
  store: Pick<AgentSessionRecordStore, 'getOperationRow'>,
  identity: PreparedAgentLaunchIdentity
): AgentSessionOperationRow | null {
  const row = store.getOperationRow(PREPARED_LAUNCH_ROW_CALLER, identity.operationId)
  return row?.fingerprint === identity.fingerprint ? row : null
}

/** The final answer the retiring transaction saved for this exact launch and agent incarnation. */
export function readPreparedLaunchAnswer(
  row: AgentSessionOperationRow | null,
  identity: PreparedAgentLaunchIdentity,
  incarnationId: string | null | undefined
): { warning?: string } | null {
  const answer =
    row?.fingerprint === identity.fingerprint && row.outcome.status === 'succeeded'
      ? row.outcome.launch
      : undefined
  if (
    typeof answer !== 'object' ||
    answer === null ||
    !incarnationId ||
    !('incarnationId' in answer) ||
    answer.incarnationId !== incarnationId
  ) {
    return null
  }
  const warning = 'warning' in answer ? answer.warning : undefined
  return typeof warning === 'string' ? { warning } : {}
}

/** The saved reason this launch left no agent, as the sentence every later caller receives. */
export function readPreparedLaunchFailure(row: AgentSessionOperationRow | null): string | null {
  return row?.outcome.status === 'failed' && row.outcome.message ? row.outcome.message : null
}

/** Kept until its answer is recorded or the launch is gone, so a failed write retries recording only. */
export function forgetPreparedPromptContinuation(identity: PreparedAgentLaunchIdentity): void {
  continuations.delete(preparedLaunchKey(identity))
}
