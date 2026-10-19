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
import { stopAgentSessionProviderRoot } from './structured-agent-session-provider-exit-proof'

/** Stops one chat captured by a workspace Sleep and reports whether the stop is proven. */
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
    if (child) {
      await input.stopAgent(sessionId, { cause: 'user-close' })
    } else if (input.owned) {
      ownedStopped = await stopAgentSessionProviderRoot(
        () => deps.adapter.releaseAcquisition?.({ sessionId }) ?? Promise.resolve(false)
      )
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
            return recordAgentSessionAcquisitionExit(record, receipt, input.fence, input.now())
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
  // A released reservation may still have an unproven root after restart; only
  // exit evidence or a never-started record proves an unheld chat is stopped.
  const alreadyStopped =
    !!after &&
    after.lease.runtimeFence === input.fence &&
    agentSessionLeaseIsReleased(after.lease) &&
    (agentSessionLeaseOwnerVerdict(after.lease) === 'exited' ||
      structuredSessionNeverStarted(after)) &&
    !sessions.get(sessionId)?.child &&
    deps.adapter.hasOwnedAcquisition?.(sessionId) !== true
  return childStopped || ownedStopped || alreadyStopped
}
