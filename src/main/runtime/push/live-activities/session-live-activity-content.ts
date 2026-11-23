import { sliceAtCodeUnitLimit } from '../../../../shared/text/surrogate-safe-text-slice'
import {
  agentVerdictDisplayMark,
  agentTurnEndedOnPurpose
} from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'
import { isAgentStatusFresh } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { RuntimeMobileSessionClientTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { LiveActivityContent } from '../../../../shared/notifications/live-activity-contract'

export function sessionLiveActivityContent(
  tab: RuntimeMobileSessionClientTab | undefined,
  showNames: boolean,
  previous: LiveActivityContent | undefined,
  now: number
): LiveActivityContent {
  const status =
    tab?.type === 'terminal'
      ? tab.agentStatus
      : tab?.type === 'agent-session'
        ? tab.chatStatus
        : undefined
  const state: LiveActivityContent['state'] =
    !status ||
    !isAgentStatusFresh(status, now) ||
    agentTurnEndedOnPurpose(status) ||
    agentVerdictDisplayMark(status) === 'unconfirmed' ||
    ('sessionBoundary' in status && status.sessionBoundary === true)
      ? 'unavailable'
      : agentVerdictDisplayMark(status) === 'failed'
        ? 'failed'
        : status.state === 'done'
          ? 'done'
          : status.state === 'working'
            ? 'working'
            : 'attention'
  const startedAt =
    status && 'stateStartedAt' in status ? status.stateStartedAt : status?.mainAgent?.stateStartedAt
  return {
    state,
    title: showNames && tab?.title ? sliceAtCodeUnitLimit(tab.title, 80) : 'Orca',
    stateStartedAt:
      typeof startedAt === 'number' && Number.isFinite(startedAt)
        ? Math.max(0, Math.min(startedAt, now)) / 1000
        : previous?.state === state
          ? previous.stateStartedAt
          : now / 1000,
    updatedAt: now / 1000
  }
}
