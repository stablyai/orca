import {
  isAgentStatusState,
  normalizeMainAgentStatusField,
  type AgentStatusEntry
} from '../../../src/shared/agent-status/contracts/agent-status-types'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import {
  hasUnacknowledgedTabCompletion,
  isInTurnDotState,
  markWorktreeUnreadForTabCompletion,
  recordCatalogAgentTabState
} from './tab-completion-state'

export type ReconciledTerminalAgentStatus = Pick<
  AgentStatusEntry,
  | 'state'
  | 'updatedAt'
  | 'stateStartedAt'
  | 'evidenceObservedAt'
  | 'mirroredEvidenceReceivedAt'
  | 'structuredHostOwned'
  | 'workingMode'
  | 'interrupted'
  | 'mainAgent'
  | 'restoredUnconfirmed'
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function toReconciledStatus(
  source: Record<string, unknown>,
  fallbackReceivedAt?: number
): ReconciledTerminalAgentStatus | null {
  if (!isAgentStatusState(source.state) || typeof source.updatedAt !== 'number') {
    return null
  }
  const receivedAt =
    typeof source.mirroredEvidenceReceivedAt === 'number'
      ? source.mirroredEvidenceReceivedAt
      : fallbackReceivedAt
  return {
    state: source.state,
    updatedAt: source.updatedAt,
    stateStartedAt:
      typeof source.stateStartedAt === 'number' ? source.stateStartedAt : source.updatedAt,
    evidenceObservedAt:
      typeof source.evidenceObservedAt === 'number' ? source.evidenceObservedAt : undefined,
    mirroredEvidenceReceivedAt: receivedAt,
    structuredHostOwned: source.structuredHostOwned === true ? true : undefined,
    workingMode: source.workingMode === 'monitoring' ? 'monitoring' : undefined,
    interrupted: typeof source.interrupted === 'boolean' ? source.interrupted : undefined,
    mainAgent: normalizeMainAgentStatusField(source.mainAgent),
    restoredUnconfirmed: source.restoredUnconfirmed === true ? true : undefined
  }
}

function catalogAgentTabId(paneKey: string): string {
  const colonIdx = paneKey.indexOf(':')
  return colonIdx === -1 ? paneKey : paneKey.slice(0, colonIdx)
}

function catalogAgentTabKeys(paneKey: string, tabCount: number): string[] {
  const tabId = catalogAgentTabId(paneKey)
  const keys = [`pane:${paneKey}`, `tab:${paneKey.replace(':', '::')}`]
  if (tabCount === 1) {
    keys.push(`tab:${tabId}`)
  }
  return keys
}

export function syncUnreadWorktreeForTabStatus(worktree: unknown, receivedAt = Date.now()): void {
  if (!isRecord(worktree)) {
    return
  }
  const wtId =
    typeof worktree.worktreeId === 'string'
      ? worktree.worktreeId
      : typeof worktree.id === 'string'
        ? worktree.id
        : undefined
  const isUnread = worktree.unread === true || worktree.isUnread === true
  if (isUnread && wtId) {
    markWorktreeUnreadForTabCompletion(wtId)
  }
  if (!Array.isArray(worktree.agents)) {
    return
  }
  const tabCounts = new Map<string, number>()
  for (const row of worktree.agents) {
    if (!isRecord(row) || typeof row.paneKey !== 'string') {
      continue
    }
    const tabId = catalogAgentTabId(row.paneKey)
    tabCounts.set(tabId, (tabCounts.get(tabId) ?? 0) + 1)
  }
  const prepared: {
    keys: string[]
    rawState: AgentDotState | undefined
    doneStamp: number | undefined
  }[] = []
  for (const row of worktree.agents) {
    if (!isRecord(row) || typeof row.paneKey !== 'string') {
      continue
    }
    const keys = catalogAgentTabKeys(
      row.paneKey,
      tabCounts.get(catalogAgentTabId(row.paneKey)) ?? 0
    )
    const status = toReconciledStatus(row, receivedAt)
    const rawState =
      status && !status.restoredUnconfirmed ? agentDotState(status, receivedAt) : undefined
    const doneStamp = status ? (status.stateStartedAt ?? status.updatedAt) : undefined
    recordCatalogAgentTabState({ keys, rawState, doneStamp })
    prepared.push({ keys, rawState, doneStamp })
  }
  if (!isUnread) {
    return
  }
  const covered = prepared.some(
    (item) =>
      isInTurnDotState(item.rawState) || hasUnacknowledgedTabCompletion(item.keys, item.rawState)
  )
  if (covered) {
    return
  }
  const doneAgents = prepared.filter((item) => item.rawState === 'done')
  let maxStamp = -Infinity
  for (const item of doneAgents) {
    if (item.doneStamp !== undefined && item.doneStamp > maxStamp) {
      maxStamp = item.doneStamp
    }
  }
  const targets =
    maxStamp === -Infinity ? doneAgents : doneAgents.filter((item) => item.doneStamp === maxStamp)
  for (const target of targets) {
    recordCatalogAgentTabState({
      keys: target.keys,
      rawState: 'done',
      doneStamp: target.doneStamp,
      forceUnreadIfUnacknowledged: true
    })
  }
}
