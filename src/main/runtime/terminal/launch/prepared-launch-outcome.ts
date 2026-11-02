import {
  forgetPreparedPromptContinuation,
  PREPARED_LAUNCH_ROW_CALLER
} from './prepared-terminal-prompt-delivery'
import type { AgentSessionOperationOutcome } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import {
  preparedLaunchFailureText,
  type PreparedAgentLaunchDescriptor,
  type PreparedAgentLaunchIdentity,
  type PreparedAgentLaunchNotice,
  type PreparedLaunchFailureReason
} from '../../../../shared/prepared-agent-launch'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-types'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'

/** The launch's final answer: the published agent, or the one reason there is none. */
export type PreparedLaunchFinal =
  | { kind: 'published'; terminal: RuntimeTerminalCreate }
  | { kind: 'not-started'; reason: PreparedLaunchFailureReason }

export type PreparedLaunchOutcomePorts = {
  controller: RuntimePtyController
  store: Pick<AgentSessionRecordStore, 'retirePreparedAgentLaunch'>
  /** One short desktop notice for an outcome no surviving terminal shows. */
  notifyLaunchNotice?: (notice: PreparedAgentLaunchNotice) => void
}

type Explanation = { kind: PreparedAgentLaunchNotice['kind']; setupLine: boolean }

/** Exhaustive, so a new final outcome cannot be left unexplained. */
function explanationOf(final: PreparedLaunchFinal): Explanation | null {
  if (final.kind === 'published') {
    return final.terminal.warning ? { kind: 'prompt-uncertain', setupLine: false } : null
  }
  switch (final.reason) {
    case 'setup-failed':
    case 'setup-timeout':
      // Setup may still be open; its last line is where the user is already looking.
      return { kind: final.reason, setupLine: true }
    case 'setup-ended':
    case 'setup-not-started':
    case 'spawn-failed':
    case 'exited':
    case 'expired':
      return { kind: final.reason, setupLine: false }
    case 'cancelled':
      // Only its own creator withdraws a launch, and that creator already answered its caller.
      return null
  }
}

function recordedOutcome(
  final: PreparedLaunchFinal,
  descriptor: PreparedAgentLaunchDescriptor
): AgentSessionOperationOutcome {
  return final.kind === 'published'
    ? { status: 'succeeded', sessionId: '', launch: final.terminal }
    : {
        status: 'failed',
        code: final.reason,
        message: preparedLaunchFailureText(final.reason, descriptor.claim.agent)
      }
}

/**
 * Removes the exact descriptor and records its final answer in one transaction. Only the
 * transaction that removed it explains the outcome, once; observers and retries replay the answer.
 */
export async function retirePreparedDescriptor(
  ports: PreparedLaunchOutcomePorts,
  identity: PreparedAgentLaunchIdentity,
  descriptor: PreparedAgentLaunchDescriptor,
  final?: PreparedLaunchFinal
): Promise<void> {
  const explanation = final ? explanationOf(final) : null
  // Setup's owner answers before the launch retires: a lost reply leaves it for a later observer
  // to ask again, so an unknown write never turns into a second surface.
  const inSetup =
    explanation?.setupLine && explanation.kind !== 'prompt-uncertain'
      ? await writeSetupLine(
          ports,
          identity,
          preparedLaunchFailureText(explanation.kind, descriptor.claim.agent)
        )
      : false
  const removed = await ports.store.retirePreparedAgentLaunch({
    callerKey: PREPARED_LAUNCH_ROW_CALLER,
    ...identity,
    ...(final ? { outcome: recordedOutcome(final, descriptor) } : {})
  })
  forgetPreparedPromptContinuation(identity)
  if (removed && explanation && !inSetup) {
    ports.notifyLaunchNotice?.({
      operationId: identity.operationId,
      worktreeId: descriptor.surface.worktreeId,
      agent: descriptor.claim.agent,
      kind: explanation.kind
    })
  }
}

/** The owner's one answer: true when the line is in Setup, false when it never will be. */
async function writeSetupLine(
  ports: PreparedLaunchOutcomePorts,
  identity: PreparedAgentLaunchIdentity,
  text: string
): Promise<boolean> {
  const reply = await ports.controller.preparedAgentLaunch?.({
    action: 'writeSetupOutcome',
    identity,
    text
  })
  if (typeof reply !== 'object' || reply === null || !('written' in reply)) {
    // No answer is not a "no": the launch stays unretired until its owner says which.
    throw new Error('agent_session_ownership_unknown')
  }
  return reply.written === true
}
