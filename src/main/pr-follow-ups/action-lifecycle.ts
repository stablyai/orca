import { followUpActivityIdentity } from './activity-journal'
import type { FollowUpEngine } from './engine'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS } from '../../shared/agent-session/agent-session-host-authority'
import type { FollowUpAction } from '../../shared/pr-follow-ups/contracts'
import type { FollowUpEngineDependencies } from './engine-contract'
import { settleFollowUpReceipt } from './dispatch'

export function readFollowUpActivity(
  deps: FollowUpEngineDependencies,
  action: FollowUpAction
): { working: boolean | 'unknown'; at: number } {
  try {
    const value = deps.working(action)
    return typeof value === 'object' ? value : { working: value, at: deps.now?.() ?? Date.now() }
  } catch {
    return { working: 'unknown', at: deps.now?.() ?? Date.now() }
  }
}

export async function reconcileFollowUpActions(
  deps: FollowUpEngineDependencies,
  prKey: string
): Promise<void> {
  for (const action of deps.store.actions(prKey, true)) {
    if (action.status === 'claimed' || action.status === 'unconfirmed') {
      const receipt = await deps.recover(action).catch(() => ({ status: 'unconfirmed' as const }))
      if (
        receipt.status === 'unconfirmed' &&
        (deps.now?.() ?? Date.now()) - action.attemptStartedAt >=
          AGENT_SESSION_MAX_OPERATION_REPLAY_AGE_MS
      ) {
        action.recoveryFinalizedAt = deps.now?.() ?? Date.now()
      }
      settleFollowUpReceipt(deps, action, receipt)
    }
    if (action.status === 'accepted' && action.sessionEndedAt === undefined) {
      const revision = deps.store.activityRevision(action.instanceId)
      const live = await deps.live(action).catch(() => 'unknown' as const)
      // A snapshot started before admitted evidence cannot replace that evidence.
      if (deps.store.activityRevision(action.instanceId) !== revision) {
        continue
      }
      if (live === false) {
        action.sessionEndedAt = deps.now?.() ?? Date.now()
        deps.store.transaction(() => {
          deps.store.appendActivity(
            action.instanceId,
            followUpActivityIdentity(action),
            'terminated',
            action.sessionEndedAt!,
            action.operationId
          )
          deps.store.saveAction(action)
        })
      } else {
        const activity = readFollowUpActivity(deps, action)
        deps.store.reconcileActivity(
          action.instanceId,
          followUpActivityIdentity(action),
          activity.working === 'unknown' ? 'unknown' : activity.working ? 'working' : 'idle',
          activity.at,
          action.operationId
        )
      }
    }
  }
}

export function followUpChatActivity(
  engine: FollowUpEngine,
  workspaceChanged: (id: string, keys?: string[]) => void
): { refresh(): void; dispose(): void } {
  let chatHost: ReturnType<typeof getStructuredAgentSessionHost>
  let releaseChat: (() => void) | undefined
  const attachChat = (): void => {
    const next = getStructuredAgentSessionHost()
    if (next === chatHost) {
      return
    }
    releaseChat?.()
    chatHost = next
    releaseChat = next?.subscribeStatus({
      id: 'pr-follow-ups',
      emit: (event) => {
        const sessions =
          event.type === 'snapshot'
            ? event.sessions
            : event.type === 'status'
              ? [event.session]
              : []
        for (const session of sessions) {
          const activity =
            session.status !== null
              ? engine.activityObserved(
                  session.workspaceId,
                  session.sessionId,
                  session.status !== 'idle',
                  session.statusStartedAt ?? Date.now()
                )
              : undefined
          workspaceChanged(session.workspaceId, activity)
        }
      }
    })
  }
  attachChat()
  return { refresh: attachChat, dispose: () => releaseChat?.() }
}
