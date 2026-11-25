import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { recordAgentSessionProviderHandle } from '../../../runtime/agent-session/ownership/agent-session-provider-handle-transition'
import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionProviderOpenResult } from './structured-agent-session-provider-open-contract'
import type { StructuredAgentSessionProviderStartedContext } from './structured-agent-session-provider-started'
import { structuredAgentSessionConversationFence } from '../host/structured-agent-session-provider-child'
import {
  AgentSessionStartFailure,
  agentSessionStartFailure
} from './structured-agent-session-start-failure'
import {
  applyStructuredRewindRecovery,
  readStructuredRewindRecovery,
  type StructuredRewindRecoveryEvidence
} from '../rewind/structured-rewind-recovery'

// What a starting child's open answered, read and recorded before the start is ready.

export type OpenedProvider = StructuredAgentSessionProviderOpenResult & {
  sessionId: string
  fence: number
  acquisitionGeneration: string
}

/** Orca could not record or apply what the open answered; nothing about the agent says retry. */
export function refusedStart(instructionPolicy = false): AgentSessionStartFailure {
  return new AgentSessionStartFailure(
    new Error('Orca could not record what the agent answered at its start'),
    'never',
    instructionPolicy
      ? agentSessionFailureFact('startFailed', {
          instructionRecovery: 'commit',
          neverReachedAgent: true
        })
      : agentSessionFailureFact('hostStopped')
  )
}

/** Reconcile uncertain rewind before delivery; persistent uncertainty fails startup with the
 *  adapter's verdict on its read, or as final when Orca's own reading failed. */
export async function readRewindAtStart(
  context: StructuredAgentSessionProviderStartedContext,
  event: OpenedProvider,
  signal?: AbortSignal
): Promise<StructuredRewindRecoveryEvidence | AgentSessionStartFailure> {
  const { sessionId } = event
  const journal = context.sessions.get(sessionId)?.journal
  if (!journal) {
    return null
  }
  try {
    return await readStructuredRewindRecovery(
      context.deps,
      sessionId,
      journal,
      structuredAgentSessionConversationFence(context.deps.store, sessionId),
      context.deps.adapter,
      signal,
      recordWithStartedHandle(context, event)
    )
  } catch (error) {
    rewindRecoveryFailed(context, sessionId, error, signal)
    return agentSessionStartFailure(error)
  }
}

/** Predict the committed handle for rewind cuts; if recording is refused, retain the existing record. */
function recordWithStartedHandle(
  context: StructuredAgentSessionProviderStartedContext,
  { sessionId, fence, link }: OpenedProvider
): AgentSessionRecord | null {
  const record = context.deps.store.getRecord(sessionId)
  try {
    return record && link
      ? recordAgentSessionProviderHandle({ record, fence, link, now: context.now() })
      : record
  } catch {
    return record
  }
}

export async function applyRewindAtStart(
  context: StructuredAgentSessionProviderStartedContext,
  sessionId: string,
  session: StructuredAgentSessionHostSession,
  evidence: StructuredRewindRecoveryEvidence
): Promise<boolean> {
  try {
    await applyStructuredRewindRecovery(
      context.deps,
      sessionId,
      session.journal,
      structuredAgentSessionConversationFence(context.deps.store, sessionId),
      evidence
    )
    return true
  } catch (error) {
    rewindRecoveryFailed(context, sessionId, error)
    return false
  }
}

function rewindRecoveryFailed(
  context: StructuredAgentSessionProviderStartedContext,
  sessionId: string,
  error: unknown,
  signal?: AbortSignal
): void {
  if (!signal?.aborted) {
    context.deps.logger.warn('settling a rewind in doubt at the start failed', {
      scope: 'rewind-recovery',
      sessionId,
      error
    })
  }
}

/** Persist the opened handle before delivery so future starts can resume; false if no handle is proven. */
export async function recordStartedHandle(
  context: {
    now: () => number
    deps: Pick<
      StructuredAgentSessionProviderStartedContext['deps'],
      'store' | 'logger' | 'turnContext' | 'nameProviderConversation'
    >
  },
  event: OpenedProvider
): Promise<boolean> {
  const { store, logger } = context.deps
  const { link } = event
  if (!link) {
    // Only an already-proven handle permits open without a new link.
    return store.getRecord(event.sessionId)?.lease.provenHandleLinkId != null
  }
  try {
    const policy = event.instructionPolicy
    const instructionContext = event.instructionContext
    const snapshot = policy && context.deps.turnContext?.instructionSnapshot?.(event.sessionId)
    if (policy && (!instructionContext || !snapshot)) {
      throw new Error('agent_session_checkpoint_stale')
    }
    const committed = await store.updateRecord(event.sessionId, {
      kind: 'provider-handle',
      args: { fence: event.fence, link, now: context.now() },
      launched: context.deps.turnContext?.launchedInstructions?.(event.sessionId) ?? null,
      ...(policy && instructionContext && snapshot
        ? {
            instruction: {
              policy,
              context: instructionContext,
              snapshot: {
                botId: snapshot.botId,
                standing: snapshot.standing,
                digest: snapshot.digest,
                baseline: snapshot.baseline
              },
              fence: event.fence,
              generation: event.acquisitionGeneration
            }
          }
        : {})
    })
    if (instructionContext) {
      context.deps.turnContext?.instructionsAccepted?.(
        event.sessionId,
        instructionContext.digest,
        instructionContext.filesIncluded,
        committed.instructionPolicy?.baseline
      )
    }
    // Inherit only a committed new context; a resumed CLI keeps its own later title.
    if (event.newConversation ?? (link.origin === 'created' || link.origin === 'forked')) {
      context.deps.nameProviderConversation?.(committed)
    }
    return true
  } catch (error) {
    logger.warn('recording the handle a started provider answered with failed', {
      scope: 'provider-started-handle',
      sessionId: event.sessionId,
      error
    })
    return false
  }
}
