import { normalizeAgentStatusPayload } from '../../shared/agent-status/contracts/agent-status-types'
import { withMirroredEvidenceReceipt } from '../../shared/agent-status/contracts/agent-status-freshness'
import { toRuntimeExecutionHostId } from '../../shared/execution-host/execution-host'
import { structuredAgentSessionStatusPaneKey } from '../../shared/agent-session/view/structured-agent-session-tab'
import { structuredAgentSessionTabId } from '../../shared/agent-session/view/structured-agent-session-projection'
import { isTerminalLeafId, makePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import type { NotchStatusObservation } from '../../shared/notch/notch-status-summary'

export type NotchRemoteObservation = NotchStatusObservation & {
  hostMainAgentStateStartedAt?: number
}

export function isNotchSessionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Project host clocks to stable local receipts; repeated inventory frames cannot renew old evidence. */
export function notchRemoteSessionRows(
  environmentId: string,
  snapshot: Record<string, unknown>,
  previous: ReadonlyMap<string, NotchRemoteObservation>,
  now: number,
  ownerIdentity: string
): NotchRemoteObservation[] {
  if (typeof snapshot.worktree !== 'string' || !Array.isArray(snapshot.tabs)) {
    return []
  }
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  const rows: NotchRemoteObservation[] = []
  for (const tab of snapshot.tabs) {
    if (!isNotchSessionRecord(tab)) {
      continue
    }
    const structured = tab.type === 'agent-session'
    if (tab.type !== 'terminal' && !structured) {
      continue
    }
    const raw = structured ? tab.chatStatus : tab.agentStatus
    if (!isNotchSessionRecord(raw) || !finite(raw.updatedAt)) {
      continue
    }
    const status = normalizeAgentStatusPayload(raw)
    if (!status || raw.providerSessionOnly === true) {
      continue
    }
    const sessionId = structured && typeof tab.sessionId === 'string' ? tab.sessionId : undefined
    let originalPaneKey: string
    let tabId: string
    let leafId: string | null
    if (structured) {
      if (!sessionId) {
        continue
      }
      originalPaneKey = structuredAgentSessionStatusPaneKey(sessionId)
      tabId = structuredAgentSessionTabId(sessionId)
      leafId = null
    } else {
      if (
        typeof tab.parentTabId !== 'string' ||
        !tab.parentTabId ||
        tab.parentTabId.includes(':') ||
        typeof tab.leafId !== 'string' ||
        !isTerminalLeafId(tab.leafId)
      ) {
        continue
      }
      tabId = tab.parentTabId
      leafId = tab.leafId
      originalPaneKey = makePaneKey(tabId, leafId)
    }
    const paneKey = `${executionHostId}|${originalPaneKey}`
    const old = previous.get(paneKey)
    const evidenceObservedAt = finite(raw.evidenceObservedAt)
      ? raw.evidenceObservedAt
      : raw.updatedAt
    const receipt = withMirroredEvidenceReceipt<{
      updatedAt: number
      evidenceObservedAt: number
      mirroredEvidenceReceivedAt?: number
    }>(
      { updatedAt: raw.updatedAt, evidenceObservedAt },
      old ? { ...old, updatedAt: old.receivedAt } : undefined,
      now
    )
    const transition = finite(raw.stateStartedAt)
      ? raw.stateStartedAt
      : status.mainAgent?.stateStartedAt
    const sameTransition =
      old?.state === status.state &&
      (transition === undefined || old.hostStateStartedAt === transition)
    rows.push({
      ...status,
      ...(status.mainAgent
        ? {
            mainAgent: {
              ...status.mainAgent,
              stateStartedAt:
                old?.mainAgent?.state === status.mainAgent.state &&
                old.hostMainAgentStateStartedAt === status.mainAgent.stateStartedAt
                  ? old.mainAgent.stateStartedAt
                  : now
            },
            hostMainAgentStateStartedAt: status.mainAgent.stateStartedAt
          }
        : {}),
      paneKey,
      ...(finite(raw.turnStartedAt) ? { turnStartedAt: raw.turnStartedAt } : {}),
      completionIdentity: JSON.stringify([
        ownerIdentity,
        status.state,
        transition ?? evidenceObservedAt,
        finite(raw.turnStartedAt) ? raw.turnStartedAt : null
      ]),
      originalPaneKey,
      executionHostId,
      sessionId,
      title: typeof tab.title === 'string' ? tab.title : undefined,
      agentType: status.agentType ?? (structured ? statusAgent(tab.agent) : undefined),
      worktreeId: snapshot.worktree,
      tabId,
      leafId,
      connectionId: null,
      receivedAt: receipt.mirroredEvidenceReceivedAt ?? now,
      evidenceObservedAt,
      mirroredEvidenceReceivedAt: receipt.mirroredEvidenceReceivedAt,
      stateStartedAt: sameTransition ? old.stateStartedAt : now,
      ...(transition !== undefined ? { hostStateStartedAt: transition } : {}),
      ...(raw.restoredUnconfirmed === true ? { restoredUnconfirmed: true } : {}),
      ...(raw.sessionBoundary === true ? { sessionBoundary: true } : {}),
      ...(structured
        ? { structuredHost: raw.structuredHostOwned === true ? 'owned' : 'held' }
        : {}),
      ...(raw.structuredHostOwned === true ? { structuredHostOwned: true } : {})
    })
  }
  return rows
}

function statusAgent(agent: unknown): NotchStatusObservation['agentType'] {
  return normalizeAgentStatusPayload({ state: 'working', agentType: agent })?.agentType
}
