import type { PtyPaneOf } from './terminal/surface/pty-pane-query'
import type { TerminalHandleRecord } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalSurfaceCloseIdentity } from '../../shared/terminal-tab-close'
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

/** An immutable snapshot of one partition's copy of a tab: row, bindings and incarnations. */
export type PersistedTerminalTabCopy = PersistedTerminalTabIdentity | null

export function capturePersistedTerminalTabCopy(
  session: WorkspaceSessionState | null | undefined,
  worktreeId: string,
  tabId: string
): PersistedTerminalTabCopy {
  return capturePersistedTerminalTabRetirementIdentity(session ?? null, worktreeId, tabId)
}

export function isSamePersistedTerminalTabCopy(
  left: PersistedTerminalTabCopy,
  right: PersistedTerminalTabCopy
): boolean {
  if (!left || !right) {
    return left === right
  }
  return (
    left.createdAt === right.createdAt &&
    left.generation === right.generation &&
    left.ptyId === right.ptyId &&
    left.remoteSessionId === right.remoteSessionId &&
    left.leaves.size === right.leaves.size &&
    [...left.leaves].every(([leafId, binding]) => {
      const other = right.leaves.get(leafId)
      return other?.ptyId === binding.ptyId && other.incarnationId === binding.incarnationId
    })
  )
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

export { captureTerminalSurfaceIdentity as captureTerminalSurfaceCloseIdentity } from '../../shared/terminal-tab-close'

/** A captured source narrows the existing authenticated handle; it cannot address another owner. */
export function isOriginalTerminalHandle(args: {
  runtimeId: string
  record: TerminalHandleRecord | undefined
  currentPty: RuntimePtyWorktreeRecord | null | undefined
  paneOfPty: PtyPaneOf
  leaf: RuntimeLeafRecord | undefined
  source: TerminalSurfaceCloseIdentity
  incarnation: string | undefined
}): boolean {
  const { runtimeId, record, currentPty, paneOfPty, leaf, source, incarnation } = args
  return (
    !!incarnation &&
    !!source.ptyId &&
    source.incarnationId === incarnation &&
    !!record &&
    record.runtimeId === runtimeId &&
    record.worktreeId === source.worktreeId &&
    record.ptyId === source.ptyId &&
    (!currentPty ||
      (currentPty.incarnationId === incarnation && currentPty.worktreeId === source.worktreeId)) &&
    (!leaf ||
      (leaf.worktreeId === source.worktreeId && (!leaf.ptyId || leaf.ptyId === source.ptyId))) &&
    ((record.tabId === source.tabId && record.leafId === source.leafId) ||
      (!!currentPty && paneOfPty(currentPty).paneKey === `${source.tabId}:${source.leafId}`))
  )
}

/** Derives presentation from the authenticated addressed owner, retaining absent-row evidence. */
export function captureAddressedTerminalPresentation(args: {
  runtimeId: string
  record: TerminalHandleRecord | undefined
  currentPty: RuntimePtyWorktreeRecord | null | undefined
  paneOfPty: PtyPaneOf
  leaf: RuntimeLeafRecord | null | undefined
  row: TerminalSurfaceCloseIdentity | null | undefined
  address: { worktreeId: string; tabId: string; leafId: string }
  ptyId: string | null
  incarnationId: string | null | undefined
}): TerminalSurfaceCloseIdentity | null {
  const { row, address, leaf, ptyId, incarnationId } = args
  const source: TerminalSurfaceCloseIdentity = {
    ...address,
    createdAt: row?.createdAt ?? null,
    generation: row?.generation ?? 0,
    hasLeaf: !!leaf || row?.hasLeaf === true,
    ptyId,
    incarnationId: incarnationId ?? null
  }
  return (!row?.ptyId || row.ptyId === ptyId) &&
    (!row?.incarnationId || row.incarnationId === incarnationId) &&
    isOriginalTerminalHandle({
      ...args,
      source,
      leaf: leaf ?? undefined,
      incarnation: incarnationId ?? undefined
    })
    ? source
    : null
}
