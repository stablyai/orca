import { agentSessionInstructionScope } from '../../../runtime/agent-session/records/agent-session-instruction-scope'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild,
  StructuredAgentSessionProviderChildIdentity
} from '../host/structured-agent-session-host-types'
import {
  agentSessionFailureFact,
  type SubmissionRejectionFact
} from '../../../../shared/agent-session/failures/agent-session-failure'
import type { AgentSessionInstructionRecovery } from '../../../../shared/agent-session/failures/agent-session-failure-details'
import { refuseUnclassified } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { agentSessionWriteNoticeEnglish } from '../../../../shared/agent-session/failures/agent-session-refusal-notice'
import type { StructuredAgentSessionAttachContext } from '../acquisition/structured-agent-session-attach-context'
import { sameProviderChild } from '../host/structured-agent-session-provider-child'
import { stopStructuredAgentSessionAgentUnderSerialize } from '../termination/structured-agent-session-host-lifetime'
import { holdUnsettledStart } from '../delivery/structured-agent-session-input-selection'

export class BotInstructionRecoveryDeadline extends Error {}

export function instructionRecoveryFailure(instructionRecovery: AgentSessionInstructionRecovery) {
  return agentSessionFailureFact('startFailed', { instructionRecovery, neverReachedAgent: true })
}

function recoveringBotInstructions(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'isBotHome'>,
  sessionId: string
): boolean {
  const record = deps.store.getRecord(sessionId)
  return (
    record?.provider === 'codex' &&
    record.providerHandleChain.length > 0 &&
    deps.isBotHome?.(record.location.workspaceId) === true
  )
}

/** Startup joins the real close outside the lane, after arming its recovery deadline. */
export function deferBotInstructionRetirement(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'isBotHome'>,
  sessionId: string,
  session: StructuredAgentSessionHostSession | undefined
): boolean {
  const child = session?.child
  if (
    !session ||
    !child ||
    child.phase !== 'ready' ||
    child.close ||
    !recoveringBotInstructions(deps, sessionId)
  ) {
    return false
  }
  child.close = {
    cause: 'evict',
    reason: null,
    recorded: Promise.resolve(null),
    requestedAt: session.journal.cursor()
  }
  return true
}

export function beginInstructionRecoveryDeadline(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  abort: (reason: Error) => void
): () => void {
  const recovering = recoveringBotInstructions(context.deps, sessionId)
  const startedAt = Date.now()
  const deadline = recovering
    ? setTimeout(
        () => abort(new BotInstructionRecoveryDeadline()),
        Math.max(0, startedAt + 10_000 - Date.now())
      )
    : null
  return () => {
    if (deadline !== null) {
      clearTimeout(deadline)
    }
  }
}

export async function settleInstructionRecoveryFailure(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  startedFor: string | undefined,
  children: readonly StructuredAgentSessionProviderChildIdentity[],
  writing: Promise<void>,
  failure: SubmissionRejectionFact
) {
  const journal = context.sessions.get(sessionId)?.journal
  const release =
    startedFor !== undefined && children.length === 0 && journal
      ? holdUnsettledStart(journal, startedFor)
      : undefined
  try {
    await writing
    if (
      startedFor !== undefined &&
      (await context.sessions.get(sessionId)?.journal.reads.submission(startedFor))
        ?.dispatchState !== 'rejected'
    ) {
      return unknownTaskGate()
    }
    release?.()
    return null
  } catch {
    return unknownTaskGate()
  } finally {
    const stopping = context.serialize(sessionId, async () => {
      const session = context.sessions.get(sessionId)
      const child = session?.child
      const task =
        startedFor === undefined ? undefined : await session?.journal.reads.submission(startedFor)
      if (
        child &&
        children.some((owned) => sameProviderChild(owned, child)) &&
        (startedFor === undefined ||
          (task?.handedOverAt === undefined &&
            (task?.dispatchState === 'pending' || task?.dispatchState === 'rejected')))
      ) {
        await stopStructuredAgentSessionAgentUnderSerialize(context, sessionId, {
          cause: 'host-stop',
          resting: true,
          failure
        })
      }
    })
    context.tasks.trackAttach(
      stopping.catch((error: unknown) =>
        context.deps.logger.warn('closing an instruction recovery writer failed', {
          scope: 'instruction-recovery-close',
          sessionId,
          error
        })
      )
    )
  }
}

function unknownTaskGate() {
  return {
    ok: false as const,
    refusal: refuseUnclassified(
      'agent_session_operation_unknown',
      agentSessionWriteNoticeEnglish(['sendOutcomeLost'])
    )
  }
}

export function instructionBindingNeedsAcquisition(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'isBotHome' | 'turnContext'>,
  sessionId: string,
  child: StructuredAgentSessionProviderChild | null | undefined
): boolean {
  const record = deps.store.getRecord(sessionId)
  if (
    !record ||
    record.provider !== 'codex' ||
    deps.isBotHome?.(record.location.workspaceId) !== true ||
    !child ||
    child.phase !== 'ready' ||
    child.close
  ) {
    return false
  }
  const policy = record.instructionPolicy
  return (
    !policy ||
    policy.state !== 'delivered' ||
    policy.fence !== child.fence ||
    policy.generation !== child.generation ||
    policy.anchor !== record.providerHandleChain.at(-1)?.linkId ||
    child.instructionAccount === undefined ||
    policy.scope !== agentSessionInstructionScope(record, child.instructionAccount) ||
    deps.turnContext?.instructionsCurrent?.(record) !== true
  )
}
