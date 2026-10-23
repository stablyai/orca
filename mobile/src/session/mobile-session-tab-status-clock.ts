import { withMirroredEvidenceReceipt } from '../../../src/shared/agent-status-freshness'
import type { AgentStatusEntry } from '../../../src/shared/types'
import {
  getCachedWorktrees,
  peekCachedWorktrees,
  setCachedWorktrees
} from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import type { MobileSessionTab } from './mobile-session-route-types'
import { mobileSessionTabsEqual } from './mobile-terminal-records'

type SessionTabStatusReceiptOptions = {
  cachedWorktrees?: readonly unknown[] | null
  worktreeId?: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function findWorktreeAgentRow(
  cachedWorktrees: readonly unknown[] | null | undefined,
  worktreeId: string | null | undefined,
  paneKey: string | null
): Record<string, unknown> | null {
  if (!cachedWorktrees || !worktreeId || !paneKey) {
    return null
  }
  for (const wt of cachedWorktrees) {
    if (!isRecord(wt)) {
      continue
    }
    const wtId =
      typeof wt.worktreeId === 'string' ? wt.worktreeId : typeof wt.id === 'string' ? wt.id : null
    if (wtId !== worktreeId || !Array.isArray(wt.agents)) {
      continue
    }
    for (const row of wt.agents) {
      if (isRecord(row) && row.paneKey === paneKey) {
        return row
      }
    }
  }
  return null
}

function reconcileShellMaskedAgentStatus(
  tab: Extract<MobileSessionTab, { type: 'terminal' }>,
  agentStatus: AgentStatusEntry,
  known: AgentStatusEntry | undefined,
  options?: SessionTabStatusReceiptOptions
): AgentStatusEntry {
  if (agentStatus.state !== 'done' || agentStatus.prompt !== '') {
    return agentStatus
  }
  const paneKey =
    agentStatus.paneKey ||
    (tab.parentTabId && tab.leafId ? `${tab.parentTabId}:${tab.leafId}` : null)
  const catalogRow = findWorktreeAgentRow(options?.cachedWorktrees, options?.worktreeId, paneKey)
  if (
    catalogRow &&
    typeof catalogRow.updatedAt === 'number' &&
    catalogRow.updatedAt > agentStatus.updatedAt
  ) {
    if (catalogRow.state === 'working' || catalogRow.state === 'waiting') {
      return {
        ...agentStatus,
        state: catalogRow.state,
        updatedAt: catalogRow.updatedAt,
        ...(typeof catalogRow.stateStartedAt === 'number'
          ? { stateStartedAt: catalogRow.stateStartedAt }
          : {}),
        ...(catalogRow.workingMode === 'monitoring' ? { workingMode: 'monitoring' as const } : {}),
        ...(typeof catalogRow.toolName === 'string' ? { toolName: catalogRow.toolName } : {}),
        ...(typeof catalogRow.toolInput === 'string' ? { toolInput: catalogRow.toolInput } : {}),
        ...(typeof catalogRow.interrupted === 'boolean'
          ? { interrupted: catalogRow.interrupted }
          : {})
      }
    }
    if (catalogRow.state === 'done') {
      return {
        ...agentStatus,
        updatedAt: catalogRow.updatedAt
      }
    }
  }
  if (
    known &&
    (known.state === 'working' || known.state === 'waiting') &&
    known.updatedAt > agentStatus.updatedAt &&
    known.stateStartedAt !== undefined &&
    known.stateStartedAt === agentStatus.stateStartedAt
  ) {
    return {
      ...agentStatus,
      state: known.state,
      updatedAt: known.updatedAt,
      stateStartedAt: known.stateStartedAt,
      ...(known.workingMode !== undefined ? { workingMode: known.workingMode } : {}),
      ...(known.toolName !== undefined ? { toolName: known.toolName } : {}),
      ...(known.toolInput !== undefined ? { toolInput: known.toolInput } : {}),
      ...(known.interrupted !== undefined ? { interrupted: known.interrupted } : {})
    }
  }
  return agentStatus
}

/** Host stamps are on the host's clock, so a tab's status ages from when this phone first saw its
 *  evidence, by desktop's receipt rule for status mirrored from another machine. */
export function withSessionTabStatusReceipts(
  tabs: MobileSessionTab[],
  previous: readonly MobileSessionTab[],
  now: number,
  options?: SessionTabStatusReceiptOptions
): MobileSessionTab[] {
  const previousById = new Map(previous.map((tab) => [tab.id, tab]))
  return tabs.map((tab) => {
    const prior = previousById.get(tab.id)
    if (tab.type === 'terminal' && tab.agentStatus) {
      const known = prior?.type === 'terminal' ? (prior.agentStatus ?? undefined) : undefined
      const reconciled = reconcileShellMaskedAgentStatus(tab, tab.agentStatus, known, options)
      return { ...tab, agentStatus: withMirroredEvidenceReceipt(reconciled, known, now) }
    }
    if (tab.type === 'agent-session' && tab.chatStatus) {
      const known = prior?.type === 'agent-session' ? prior.chatStatus : undefined
      return { ...tab, chatStatus: withMirroredEvidenceReceipt(tab.chatStatus, known, now) }
    }
    return tab
  })
}

export function unreconciledShellMaskedStatusKey(
  tabs: readonly MobileSessionTab[],
  worktreeId: string | null | undefined
): string | null {
  const keys: string[] = []
  for (const tab of tabs) {
    if (
      tab.type === 'terminal' &&
      tab.agentStatus?.state === 'done' &&
      tab.agentStatus.prompt === '' &&
      typeof tab.agentStatus.stateStartedAt === 'number' &&
      tab.agentStatus.stateStartedAt > tab.agentStatus.updatedAt
    ) {
      keys.push(`${tab.id}:${tab.agentStatus.stateStartedAt}`)
    }
  }
  return keys.length > 0 ? `${worktreeId ?? ''}::${keys.join('|')}` : null
}

export function applySessionTabStatusReceipts(args: {
  tabs: MobileSessionTab[]
  previous: readonly MobileSessionTab[]
  now: number
  hostId?: string | null
  worktreeId?: string | null
  client?: RpcClient | null
  probedKeys?: Set<string>
  sessionTabsRef?: { current: MobileSessionTab[] }
  setSessionTabs?: (tabs: MobileSessionTab[]) => void
}): MobileSessionTab[] {
  const cachedWorktrees = args.hostId
    ? (peekCachedWorktrees(args.hostId) ?? getCachedWorktrees(args.hostId))
    : null
  const nextTabs = withSessionTabStatusReceipts(args.tabs, args.previous, args.now, {
    cachedWorktrees,
    worktreeId: args.worktreeId
  })
  const maskedKey = unreconciledShellMaskedStatusKey(nextTabs, args.worktreeId)
  if (
    maskedKey &&
    args.hostId &&
    args.client &&
    args.probedKeys &&
    !args.probedKeys.has(maskedKey)
  ) {
    const hostId = args.hostId
    args.probedKeys.add(maskedKey)
    void worktreeCatalogRead
      .request(args.client, { limit: 10_000 })
      .then((reply) => {
        const catalog = worktreeCatalogRead.interpret(reply)
        if (!catalog.accepted || !Array.isArray(catalog.value.worktrees) || !args.sessionTabsRef) {
          return
        }
        setCachedWorktrees(hostId, catalog.value.worktrees, { proven: true })
        const refreshedTabs = withSessionTabStatusReceipts(
          args.sessionTabsRef.current,
          args.sessionTabsRef.current,
          Date.now(),
          { cachedWorktrees: catalog.value.worktrees, worktreeId: args.worktreeId }
        )
        if (!mobileSessionTabsEqual(args.sessionTabsRef.current, refreshedTabs)) {
          args.sessionTabsRef.current = refreshedTabs
          args.setSessionTabs?.(refreshedTabs)
        }
      })
      .catch(() => {})
  }
  return nextTabs
}

/** With contact lost, only a live host vouches for a chat it holds: drop that exemption so the
 *  last state ages, as desktop's revokeAgentSessionStatusLive does. A new snapshot restores it. */
export function withoutSessionTabHostOwnership(tabs: MobileSessionTab[]): MobileSessionTab[] {
  if (!tabs.some((tab) => tab.type === 'agent-session' && tab.chatStatus?.structuredHostOwned)) {
    return tabs
  }
  return tabs.map((tab) => {
    if (tab.type !== 'agent-session' || !tab.chatStatus?.structuredHostOwned) {
      return tab
    }
    const { structuredHostOwned: _owned, ...chatStatus } = tab.chatStatus
    return { ...tab, chatStatus }
  })
}
