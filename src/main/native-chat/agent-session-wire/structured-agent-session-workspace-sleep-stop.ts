import { recordAgentSessionAcquisitionExit } from '../../runtime/agent-session-acquisition-exit-transition'
import {
  agentSessionLeaseIsReleased,
  agentSessionLeaseOwnerVerdict
} from '../../../shared/agent-session-lease-adjudication'
import { structuredSessionNeverStarted } from '../../runtime/agent-session-record-founding'
import type { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionStopEnding } from './structured-agent-session-host-lifetime'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { sameProviderChild } from './structured-agent-session-provider-child'
import type { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'

export async function stopWorkspaceSleepChat(input: {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'adapter' | 'logger'>
  sessions: StructuredAgentSessionConversations
  stopAgent: (sessionId: string, ending: StructuredAgentSessionStopEnding) => Promise<void>
  sessionId: string
  fence: number
  child: StructuredAgentSessionProviderChild | null | undefined
  owned: boolean
  now: () => number
}): Promise<boolean> {
  const { deps, sessions, sessionId, child } = input
  let ownedStopped = false
  try {
    deps.store.requireWritableRecord(sessionId)
    if (child) {
      await input.stopAgent(sessionId, { cause: 'user-close' })
    } else if (input.owned) {
      const stopped = await stopAgentSessionProviderRoot(
        () => deps.adapter.releaseAcquisition?.({ sessionId }) ?? Promise.resolve(false)
      )
      ownedStopped = !!stopped
      const receipt = deps.adapter.stoppedAcquisition?.(sessionId)
      if (ownedStopped && receipt) {
        try {
          await deps.store.transitionHandoff(sessionId, (record) => {
            if (
              deps.adapter.stoppedAcquisition?.(sessionId) !== receipt ||
              sessions.get(sessionId)?.child
            ) {
              throw new Error('agent_session_ownership_unknown')
            }
            return recordAgentSessionAcquisitionExit(
              record,
              receipt,
              input.fence,
              input.now(),
              stopped === 'kill-delivered' ? stopped : undefined
            )
          })
          deps.adapter.acknowledgeSessionRelease?.(sessionId, receipt)
        } catch (error) {
          deps.logger.warn('saving failed acquisition exit evidence failed', {
            scope: 'workspace-chat-stop',
            sessionId,
            error
          })
        }
      }
    }
  } catch (error) {
    deps.logger.warn('workspace chat stop was not proven', {
      scope: 'workspace-chat-stop',
      sessionId,
      error
    })
  }
  const ended = sessions.get(sessionId)?.lastEndedChild
  const after = deps.store.getRecord(sessionId)
  const childStopped =
    !!child &&
    !sessions.get(sessionId)?.child &&
    ended?.rootGone === true &&
    sameProviderChild(ended, child)
  const alreadyStopped =
    after?.lease.runtimeFence === input.fence && workspaceSleepChatAtRest(deps, sessions, sessionId)
  return childStopped || ownedStopped || alreadyStopped
}

/** Release alone cannot prove a restarted root stopped; require exit evidence or a never-started record. */
function workspaceSleepChatAtRest(
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'adapter'>,
  sessions: StructuredAgentSessionConversations,
  sessionId: string
): boolean {
  const record = deps.store.getRecord(sessionId)
  return (
    !!record &&
    agentSessionLeaseIsReleased(record.lease) &&
    (agentSessionLeaseOwnerVerdict(record.lease) === 'exited' ||
      structuredSessionNeverStarted(record)) &&
    !sessions.get(sessionId)?.child &&
    deps.adapter.hasOwnedAcquisition?.(sessionId) !== true
  )
}

export type WorkspaceSleepCloseResult = {
  fence: number
  stopped: boolean
  admittedSends: number
}

/** Abort registered starts, then await them outside the lane their final commits need. */
export function workspaceSleepStartAborts(
  runtimeState: () => Pick<
    StructuredAgentSessionHostRuntimeState,
    'startFlights' | 'acquireAborts'
  >,
  sessionId: string
) {
  const aborted: Promise<unknown>[] = []
  return {
    abort: (): void => {
      const flight = runtimeState().startFlights.get(sessionId)
      if (flight) {
        aborted.push(flight.outcome)
      }
      runtimeState().acquireAborts.abort(sessionId, 'closed while starting')
    },
    settle: (
      input: Pick<Parameters<typeof stopWorkspaceSleepChat>[0], 'deps' | 'sessions' | 'sessionId'>,
      result: WorkspaceSleepCloseResult | null
    ) =>
      settleWorkspaceSleepAbortedStarts(input, result, aborted, () =>
        runtimeState().startFlights.has(sessionId)
      )
  }
}

/** Count an aborted start only after it settles with no newer start or remaining work. */
async function settleWorkspaceSleepAbortedStarts(
  input: Pick<Parameters<typeof stopWorkspaceSleepChat>[0], 'deps' | 'sessions' | 'sessionId'>,
  result: WorkspaceSleepCloseResult | null,
  abortedStarts: readonly Promise<unknown>[],
  startRunning: () => boolean
): Promise<WorkspaceSleepCloseResult | null> {
  await Promise.allSettled(abortedStarts)
  if (!result || result.stopped || abortedStarts.length === 0 || startRunning()) {
    return result
  }
  const { deps, sessions, sessionId } = input
  return workspaceSleepChatAtRest(deps, sessions, sessionId)
    ? {
        ...result,
        fence: deps.store.getRecord(sessionId)?.lease.runtimeFence ?? result.fence,
        stopped: true
      }
    : result
}
