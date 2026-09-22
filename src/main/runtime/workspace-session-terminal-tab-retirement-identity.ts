import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { collectPersistedTerminalLeafIds } from './mobile-session-layout-projection'

type PersistedTerminalTabIdentity = {
  createdAt: number
  generation: number
  ptyId: string | null
  remoteSessionId: string | null
  leaves: Map<string, { ptyId: string | null; incarnationId: string | null }>
}
function capturePersistedTerminalTabRetirementIdentity(
  session: WorkspaceSessionState | null,
  worktreeId: string,
  tabId: string
): PersistedTerminalTabIdentity | null {
  const row = session?.tabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
  if (!row || !session) {
    return null
  }
  const layout = session.terminalLayoutsByTabId[tabId]
  return {
    createdAt: row.createdAt,
    generation: row.generation ?? 0,
    ptyId: row.ptyId,
    remoteSessionId: session.remoteSessionIdsByTabId?.[tabId] ?? null,
    leaves: new Map(
      collectPersistedTerminalLeafIds(layout).map((leafId) => [
        leafId,
        {
          ptyId: layout?.ptyIdsByLeafId?.[leafId] ?? null,
          incarnationId: session.terminalPtyIncarnationsByPaneKey?.[`${tabId}:${leafId}`] ?? null
        }
      ])
    )
  }
}
function isRetainedTerminalTabRetirementIdentity(
  captured: PersistedTerminalTabIdentity | null,
  current: PersistedTerminalTabIdentity | null
): boolean {
  if (!current) {
    return true
  }
  if (
    !captured ||
    captured.createdAt !== current.createdAt ||
    captured.generation !== current.generation ||
    (current.ptyId !== null &&
      current.ptyId !== captured.ptyId &&
      ![...captured.leaves.values()].some((leaf) => leaf.ptyId === current.ptyId)) ||
    (current.remoteSessionId !== null &&
      current.remoteSessionId !== captured.remoteSessionId &&
      ![...captured.leaves.values()].some((leaf) => leaf.ptyId === current.remoteSessionId))
  ) {
    return false
  }
  // Physical exits may retire original leaves while the renderer close is awaiting its flush.
  return [...current.leaves].every(([leafId, binding]) => {
    const previous = captured.leaves.get(leafId)
    return (
      previous !== undefined &&
      (binding.ptyId === null || binding.ptyId === previous.ptyId) &&
      (binding.incarnationId === null || binding.incarnationId === previous.incarnationId)
    )
  })
}

type TerminalTabRetirementState = {
  hostId: string
  session: WorkspaceSessionState | null
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined
  incarnationOf: (ptyId: string) => string | null | undefined
}

export function captureAcknowledgedTerminalTabRetirement(
  worktreeId: string,
  tabId: string,
  readState: () => TerminalTabRetirementState
): () => { matches: boolean; hasPersistedTab: boolean } {
  const { hostId, session, snapshot, incarnationOf } = readState()
  const identity = capturePersistedTerminalTabRetirementIdentity(session, worktreeId, tabId)
  const surfaces = new Map(
    snapshot?.tabs.flatMap((tab) =>
      tab.type === 'terminal' && tab.parentTabId === tabId
        ? [[tab.leafId, tab.ptyId ?? null] as const]
        : []
    )
  )
  const ptyIds = new Set([
    identity?.ptyId,
    identity?.remoteSessionId,
    ...[...(identity?.leaves.values() ?? [])].map((leaf) => leaf.ptyId),
    ...surfaces.values(),
    ...(snapshot?.tabs.flatMap((tab) =>
      tab.type === 'terminal' && tab.parentTabId === tabId
        ? Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {})
        : []
    ) ?? [])
  ])
  const incarnations = new Map(
    [...ptyIds].flatMap((ptyId) => (ptyId ? [[ptyId, incarnationOf(ptyId) ?? null] as const] : []))
  )
  return () => {
    const current = readState()
    const remaining = capturePersistedTerminalTabRetirementIdentity(
      current.session,
      worktreeId,
      tabId
    )
    const matches =
      current.hostId === hostId &&
      isRetainedTerminalTabRetirementIdentity(identity, remaining) &&
      [...incarnations].every(([ptyId, incarnationId]) => {
        const next = current.incarnationOf(ptyId)
        return next === undefined || next === incarnationId
      }) &&
      !current.snapshot?.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          tab.parentTabId === tabId &&
          (!surfaces.has(tab.leafId) ||
            (tab.ptyId != null && surfaces.get(tab.leafId) !== tab.ptyId))
      )
    return { matches, hasPersistedTab: remaining !== null }
  }
}
