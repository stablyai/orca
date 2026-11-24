import { createHmac } from 'node:crypto'
import type {
  LiveActivityHostContent,
  LiveActivityState
} from '../../../../shared/notifications/live-activity-contract'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeMobileSessionClientTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { sessionTabPaneKey } from '../../../../shared/remote-runtime/session-graph/session-tab-pane-key'
import { worktreeIdentityKey } from '../../../../shared/worktree/id'
import { sliceAtCodeUnitLimit } from '../../../../shared/text/surrogate-safe-text-slice'
import { sessionLiveActivityContent } from './session-live-activity-content'
import {
  agentTurnEndedOnPurpose,
  agentVerdictDisplayMark
} from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'

const PRIORITY: Record<LiveActivityState, number> = {
  attention: 0,
  failed: 1,
  working: 2,
  unavailable: 3,
  done: 4
}
type AgentTab = Extract<RuntimeMobileSessionClientTab, { type: 'terminal' | 'agent-session' }>

export function liveActivitySessionId(
  activityId: string,
  worktreeId: string,
  paneKey: string
): string {
  return createHmac('sha256', activityId)
    .update(JSON.stringify([worktreeIdentityKey(worktreeId), paneKey]))
    .digest('hex')
    .slice(0, 32)
}

export function agentOverviewContent(
  frames: Iterable<RuntimeMobileSessionTabsResult>,
  activityId: string,
  showNames: boolean,
  now: number
): LiveActivityHostContent {
  const content: LiveActivityHostContent = {
    counts: { working: 0, attention: 0, done: 0, failed: 0, unavailable: 0 },
    sessions: [],
    complete: true
  }
  const candidates = new Map<string, { worktree: string; tab: AgentTab }>()
  for (const frame of frames) {
    if (frame.agentSessionsUnverifiable) {
      content.complete = false
    }
    for (const tab of frame.tabs) {
      if (
        tab.type !== 'agent-session' &&
        !(tab.type === 'terminal' && (tab.agentStatus || tab.launchAttested))
      ) {
        continue
      }
      const paneKey = sessionTabPaneKey(tab)
      if (!paneKey) {
        continue
      }
      const conversation =
        tab.type === 'agent-session' ? tab.sessionId : tab.agentStatus?.orcaSessionId
      const identity = conversation
        ? `session:${conversation}`
        : `pane:${liveActivitySessionId(activityId, frame.worktree, paneKey)}`
      const previous = candidates.get(identity)?.tab
      if (previous?.type === 'agent-session') {
        continue
      }
      if (
        previous?.type === 'terminal' &&
        tab.type === 'terminal' &&
        (previous.agentStatus?.updatedAt ?? 0) > (tab.agentStatus?.updatedAt ?? 0)
      ) {
        continue
      }
      candidates.set(identity, { worktree: frame.worktree, tab })
    }
  }
  for (const { worktree, tab } of candidates.values()) {
    const status = tab.type === 'terminal' ? tab.agentStatus : tab.chatStatus
    if (status?.state === 'done') {
      if (agentTurnEndedOnPurpose(status)) {
        continue
      }
      const finishedAt =
        status.mainAgent?.stateStartedAt ?? status.stateStartedAt ?? status.updatedAt
      if (agentVerdictDisplayMark(status) !== 'unconfirmed' && now - finishedAt > 5 * 60_000) {
        continue
      }
    }
    const paneKey = sessionTabPaneKey(tab)!
    const id = liveActivitySessionId(activityId, worktree, paneKey)
    const session = sessionLiveActivityContent(tab, showNames, undefined, now)
    const segment = createHmac('sha256', activityId)
      .update(
        JSON.stringify([
          session.state,
          status?.stateStartedAt ?? status?.mainAgent?.stateStartedAt ?? 0,
          status?.turnStartedAt ?? 0
        ])
      )
      .digest('hex')
      .slice(0, 32)
    content.counts[session.state] = Math.min(9999, content.counts[session.state] + 1)
    content.sessions.push({
      id,
      segment,
      state: session.state,
      title: showNames ? sliceAtCodeUnitLimit(session.title, 40) : '',
      elapsedSeconds: Math.max(0, Math.min(604800, now / 1000 - session.stateStartedAt))
    })
  }
  content.sessions.sort((a, b) => PRIORITY[a.state] - PRIORITY[b.state] || a.id.localeCompare(b.id))
  content.sessions = content.sessions.slice(0, 3)
  return content
}
