import { withMirroredEvidenceReceipt } from '../../../src/shared/agent-status-freshness'
import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import {
  getCachedWorktrees,
  peekCachedWorktrees,
  setCachedWorktrees
} from '../cache/worktree-cache'
import type { RpcClient } from '../transport/rpc-client'
import { worktreeCatalogRead } from '../worktree/worktree-catalog-operations'
import { WorktreeCatalogSnapshotClient } from '../worktree/worktree-catalog-snapshot-client'
import type { MobileSessionTab } from './mobile-session-route-types'
import { mobileSessionTabsEqual } from './mobile-terminal-records'

type SessionTabStatusReceiptOptions = {
  cachedWorktrees?: readonly unknown[] | null
  worktreeId?: string | null
}

const lastCatalogProbeAtByHost = new Map<string, number>()
const catalogProbeInFlightByHost = new Set<string>()
const snapshotClientByHost = new Map<string, WorktreeCatalogSnapshotClient>()
const CATALOG_PROBE_COOLDOWN_MS = 1500

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

function applyCatalogRowToStatus(
  base: AgentStatusEntry,
  catalogRow: Record<string, unknown>
): AgentStatusEntry | null {
  if (typeof catalogRow.updatedAt !== 'number') {
    return null
  }
  const state = catalogRow.state
  if (state !== 'working' && state !== 'waiting' && state !== 'blocked' && state !== 'done') {
    return null
  }
  const active = state !== 'done'
  return {
    ...base,
    state,
    updatedAt: Math.max(base.updatedAt, catalogRow.updatedAt),
    ...(typeof catalogRow.stateStartedAt === 'number'
      ? { stateStartedAt: catalogRow.stateStartedAt }
      : {}),
    workingMode: active && catalogRow.workingMode === 'monitoring' ? 'monitoring' : undefined,
    toolName: active && typeof catalogRow.toolName === 'string' ? catalogRow.toolName : undefined,
    toolInput:
      active && typeof catalogRow.toolInput === 'string' ? catalogRow.toolInput : undefined,
    interrupted: typeof catalogRow.interrupted === 'boolean' ? catalogRow.interrupted : undefined
  }
}

function reconcileShellMaskedAgentStatus(
  tab: Extract<MobileSessionTab, { type: 'terminal' }>,
  agentStatus: AgentStatusEntry,
  known: AgentStatusEntry | undefined,
  options?: SessionTabStatusReceiptOptions
): AgentStatusEntry {
  if (agentStatus.prompt !== '') {
    return agentStatus
  }
  const paneKey =
    agentStatus.paneKey ||
    (tab.parentTabId && tab.leafId ? `${tab.parentTabId}:${tab.leafId}` : null)
  const catalogRow = findWorktreeAgentRow(options?.cachedWorktrees, options?.worktreeId, paneKey)
  if (
    catalogRow &&
    typeof catalogRow.updatedAt === 'number' &&
    (catalogRow.updatedAt >= agentStatus.updatedAt ||
      (agentStatus.state === 'done' && catalogRow.state !== 'done'))
  ) {
    const applied = applyCatalogRowToStatus(agentStatus, catalogRow)
    if (applied) {
      return applied
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
    if (tab.type === 'terminal' && !tab.agentStatus && tab.parentTabId && tab.leafId) {
      const paneKey = `${tab.parentTabId}:${tab.leafId}`
      const catalogRow = findWorktreeAgentRow(
        options?.cachedWorktrees,
        options?.worktreeId,
        paneKey
      )
      const base: AgentStatusEntry = {
        state: 'done',
        prompt: '',
        paneKey,
        stateHistory: [],
        updatedAt: 0,
        stateStartedAt: 0
      }
      const synthesized = catalogRow ? applyCatalogRowToStatus(base, catalogRow) : null
      if (synthesized) {
        const known = prior?.type === 'terminal' ? (prior.agentStatus ?? undefined) : undefined
        return { ...tab, agentStatus: withMirroredEvidenceReceipt(synthesized, known, now) }
      }
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
    if (tab.type === 'terminal' && (!tab.agentStatus || tab.agentStatus.prompt === '')) {
      keys.push(
        `${tab.id}:${tab.agentStatus?.stateStartedAt ?? 0}:${tab.agentStatus?.updatedAt ?? 0}`
      )
    }
  }
  return keys.length > 0 ? `${worktreeId ?? ''}::${keys.join('|')}` : null
}

function applyWorktreeCatalogToSessionTabs(
  hostId: string,
  worktreeId: string | null | undefined,
  worktrees: unknown[],
  sessionTabsRef: { current: MobileSessionTab[] },
  setSessionTabs?: (tabs: MobileSessionTab[]) => void
): void {
  setCachedWorktrees(hostId, worktrees, { proven: true })
  const refreshedTabs = withSessionTabStatusReceipts(
    sessionTabsRef.current,
    sessionTabsRef.current,
    Date.now(),
    { cachedWorktrees: worktrees, worktreeId }
  )
  if (!mobileSessionTabsEqual(sessionTabsRef.current, refreshedTabs)) {
    sessionTabsRef.current = refreshedTabs
    setSessionTabs?.(refreshedTabs)
  }
}

export function refreshSessionTabWorktreeStatuses(args: {
  hostId: string
  worktreeId: string | null | undefined
  client: RpcClient
  sessionTabsRef: { current: MobileSessionTab[] }
  setSessionTabs?: (tabs: MobileSessionTab[]) => void
  force?: boolean
}): void {
  const { hostId, worktreeId, client, sessionTabsRef, setSessionTabs, force } = args
  if (catalogProbeInFlightByHost.has(hostId)) {
    return
  }
  const now = Date.now()
  if (!force && now - (lastCatalogProbeAtByHost.get(hostId) ?? 0) < CATALOG_PROBE_COOLDOWN_MS) {
    return
  }
  lastCatalogProbeAtByHost.set(hostId, now)
  catalogProbeInFlightByHost.add(hostId)
  let snapshotClient = snapshotClientByHost.get(hostId)
  if (!snapshotClient) {
    snapshotClient = new WorktreeCatalogSnapshotClient()
    snapshotClientByHost.set(hostId, snapshotClient)
  }
  void snapshotClient
    .fetch(client, hostId)
    .then((fetched) => {
      const confirmed = fetched.kind === 'response' ? snapshotClient.admit(fetched.pending) : null
      if (confirmed) {
        applyWorktreeCatalogToSessionTabs(
          hostId,
          worktreeId,
          confirmed,
          sessionTabsRef,
          setSessionTabs
        )
      }
    })
    .catch(() =>
      worktreeCatalogRead
        .request(client, { limit: 10_000 })
        .then((reply) => {
          const catalog = worktreeCatalogRead.interpret(reply)
          if (catalog.accepted && Array.isArray(catalog.value.worktrees)) {
            applyWorktreeCatalogToSessionTabs(
              hostId,
              worktreeId,
              catalog.value.worktrees,
              sessionTabsRef,
              setSessionTabs
            )
          }
        })
        .catch(() => {})
    )
    .finally(() => {
      catalogProbeInFlightByHost.delete(hostId)
    })
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
  if (maskedKey && args.hostId && args.client && args.sessionTabsRef) {
    const firstSeenForKey = args.probedKeys ? !args.probedKeys.has(maskedKey) : false
    args.probedKeys?.add(maskedKey)
    refreshSessionTabWorktreeStatuses({
      hostId: args.hostId,
      worktreeId: args.worktreeId,
      client: args.client,
      sessionTabsRef: args.sessionTabsRef,
      setSessionTabs: args.setSessionTabs,
      force: firstSeenForKey
    })
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
