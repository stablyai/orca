import {
  isAgentStatusState,
  normalizeMainAgentStatusField,
  type AgentStatusEntry
} from '../../../src/shared/agent-status/contracts/agent-status-types'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import {
  acknowledgeSupersededCatalogInTurn,
  hasHostUnacknowledgedTabCompletion,
  hasUnacknowledgedTabCompletion,
  isInTurnDotState,
  isTabCompletionAcknowledged,
  markWorktreeUnreadForTabCompletion,
  notifyTabCompletionStateChanged,
  recordCatalogAgentTabState,
  subscribeTabCompletionState
} from './tab-completion-state'

export { subscribeTabCompletionState }

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

type SessionSupersededDone = {
  updatedAt: number
  stateStartedAt: number
}

const sessionDoneByPaneKey = new Map<string, SessionSupersededDone>()

export function clearSessionSupersededDoneForTests(): void {
  sessionDoneByPaneKey.clear()
}

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

function catalogAgentLookupKeys(paneKey: string): string[] {
  const tabId = catalogAgentTabId(paneKey)
  return [`pane:${paneKey}`, `tab:${paneKey.replace(':', '::')}`, `tab:${tabId}`]
}

export function recordSessionSupersededDone(
  paneKey: string | null | undefined,
  done: SessionSupersededDone | null,
  supersededCatalogInTurn = false
): void {
  if (!paneKey) {
    return
  }
  if (!done) {
    if (sessionDoneByPaneKey.delete(paneKey)) {
      notifyTabCompletionStateChanged()
    }
    return
  }
  if (supersededCatalogInTurn) {
    acknowledgeSupersededCatalogInTurn(catalogAgentLookupKeys(paneKey), done.stateStartedAt)
  }
  const prev = sessionDoneByPaneKey.get(paneKey)
  if (prev && prev.updatedAt === done.updatedAt && prev.stateStartedAt === done.stateStartedAt) {
    return
  }
  sessionDoneByPaneKey.set(paneKey, done)
  notifyTabCompletionStateChanged()
}

export function reconcileWorktreeAgentRowWithSessionDone<T extends Record<string, unknown>>(
  row: T
): T {
  const paneKey = typeof row.paneKey === 'string' ? row.paneKey : null
  if (!paneKey || row.state === 'done') {
    return row
  }
  const sessionDone = sessionDoneByPaneKey.get(paneKey)
  if (!sessionDone) {
    return row
  }
  const rowUpdatedAt = typeof row.updatedAt === 'number' ? row.updatedAt : -Infinity
  const rowStateStartedAt =
    typeof row.stateStartedAt === 'number' ? row.stateStartedAt : rowUpdatedAt
  if (sessionDone.updatedAt > rowUpdatedAt && sessionDone.updatedAt >= rowStateStartedAt) {
    return {
      ...row,
      state: 'done',
      updatedAt: sessionDone.updatedAt,
      stateStartedAt: sessionDone.stateStartedAt
    }
  }
  if (rowUpdatedAt > sessionDone.updatedAt || rowStateStartedAt > sessionDone.updatedAt) {
    sessionDoneByPaneKey.delete(paneKey)
  }
  return row
}

export function resolveHostAgentRowDotState(
  row: RuntimeWorktreeAgentRow,
  now: number
): AgentDotState {
  const effectiveRow = reconcileWorktreeAgentRowWithSessionDone(row)
  const baseState = agentDotState(effectiveRow, now)
  if (
    baseState === 'done' &&
    hasHostUnacknowledgedTabCompletion(catalogAgentLookupKeys(row.paneKey), 'done')
  ) {
    return 'unread'
  }
  return baseState
}

export function resolveHostWorktreeRowStatus(
  item: {
    worktreeId?: string
    unread?: boolean
    agents?: readonly RuntimeWorktreeAgentRow[]
  },
  status: WorktreeStatus,
  now: number
): { status: WorktreeStatus; unread: boolean } {
  const agents = item.agents
  let hasUnreadAgent = false
  let hasInTurnAgent = false
  let hadSupersededAgent = false
  let hasAcknowledgedAgent = false
  if (agents && agents.length > 0) {
    for (const agent of agents) {
      const reconciled = reconcileWorktreeAgentRowWithSessionDone(agent)
      if (reconciled !== agent) {
        hadSupersededAgent = true
      }
      const dotState = resolveHostAgentRowDotState(reconciled, now)
      if (dotState === 'unread') {
        hasUnreadAgent = true
      } else if (isInTurnDotState(dotState)) {
        hasInTurnAgent = true
      } else if (
        dotState === 'done' &&
        isTabCompletionAcknowledged(
          catalogAgentLookupKeys(agent.paneKey),
          reconciled.stateStartedAt ?? reconciled.updatedAt
        )
      ) {
        hasAcknowledgedAgent = true
      }
    }
  }
  const rawUnread = Boolean(item.unread) && (!hasAcknowledgedAgent || hasUnreadAgent)
  const unread = rawUnread || hasUnreadAgent
  const effectiveStatus: WorktreeStatus =
    (status === 'working' || status === 'monitoring') &&
    (hadSupersededAgent || hasUnreadAgent) &&
    !hasInTurnAgent
      ? 'done'
      : status
  return { status: effectiveStatus, unread }
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
    const effectiveRow = reconcileWorktreeAgentRowWithSessionDone(row)
    const status = toReconciledStatus(effectiveRow)
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
