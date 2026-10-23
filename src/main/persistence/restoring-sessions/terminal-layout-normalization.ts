import { randomUUID } from 'node:crypto'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import {
  collectLayoutLeafIdsInOrder,
  firstLayoutLeafId
} from '../../../shared/workspace-layout/terminal-pane-tree'

export {
  collectLayoutLeafIdsInOrder,
  firstLayoutLeafId,
  layoutContainsLeafId
} from '../../../shared/workspace-layout/terminal-pane-tree'

export type LayoutLeafNormalization = {
  snapshot: TerminalLayoutSnapshot
  changed: boolean
  leafIdByInputLeafId: Map<string, string>
}

export function collectLayoutLeafCounts(
  node: TerminalPaneLayoutNode,
  counts = new Map<string, number>()
): Map<string, number> {
  if (node.type === 'leaf') {
    counts.set(node.leafId, (counts.get(node.leafId) ?? 0) + 1)
    return counts
  }
  collectLayoutLeafCounts(node.first, counts)
  collectLayoutLeafCounts(node.second, counts)
  return counts
}

export function cloneLayoutNode(node: TerminalPaneLayoutNode): TerminalPaneLayoutNode {
  if (node.type === 'leaf') {
    return { type: 'leaf', leafId: node.leafId }
  }
  return {
    ...node,
    first: cloneLayoutNode(node.first),
    second: cloneLayoutNode(node.second)
  }
}

export function cloneLayoutWithLeafIds(
  node: TerminalPaneLayoutNode,
  leafIdByInputLeafId: Map<string, string>,
  duplicatedInputLeafIds: Set<string>
): TerminalPaneLayoutNode {
  if (node.type === 'leaf') {
    return {
      type: 'leaf',
      leafId: duplicatedInputLeafIds.has(node.leafId)
        ? randomUUID()
        : (leafIdByInputLeafId.get(node.leafId) ?? randomUUID())
    }
  }
  return {
    ...node,
    first: cloneLayoutWithLeafIds(node.first, leafIdByInputLeafId, duplicatedInputLeafIds),
    second: cloneLayoutWithLeafIds(node.second, leafIdByInputLeafId, duplicatedInputLeafIds)
  }
}

export function remapLeafRecordForPersistence(
  source: Record<string, string> | undefined,
  leafIdByInputLeafId: Map<string, string>,
  duplicatedInputLeafIds: Set<string>
): Record<string, string> | undefined {
  if (!source) {
    return undefined
  }
  const next: Record<string, string> = {}
  for (const [leafId, value] of Object.entries(source)) {
    if (duplicatedInputLeafIds.has(leafId)) {
      continue
    }
    const nextLeafId = leafIdByInputLeafId.get(leafId)
    if (nextLeafId) {
      next[nextLeafId] = value
    }
  }
  return Object.keys(next).length > 0 ? next : undefined
}

export function leafRecordEquivalent(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {})
  const rightRecord = right ?? {}
  if (leftEntries.length !== Object.keys(rightRecord).length) {
    return false
  }
  return leftEntries.every(([key, value]) => rightRecord[key] === value)
}

export function preserveMissingLeafRecordEntries(
  priorRecord: Record<string, string> | undefined,
  incomingRecord: Record<string, string> | undefined,
  liveLeafIds: Set<string>
): Record<string, string> | undefined {
  const preserved = Object.fromEntries(
    Object.entries(priorRecord ?? {}).filter(
      ([leafId]) => liveLeafIds.has(leafId) && incomingRecord?.[leafId] === undefined
    )
  )
  const next = { ...preserved, ...incomingRecord }
  return Object.keys(next).length > 0 ? next : undefined
}

export function normalizeTerminalLayoutSnapshotForPersistence(
  snapshot: TerminalLayoutSnapshot,
  preferredLayout?: TerminalLayoutSnapshot
): LayoutLeafNormalization {
  const inputRoot = snapshot.root
  if (!inputRoot) {
    return { snapshot, changed: false, leafIdByInputLeafId: new Map() }
  }
  let changed = false
  const counts = collectLayoutLeafCounts(inputRoot)
  const duplicatedInputLeafIds = new Set(
    Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([leafId]) => leafId)
  )
  const inputLeafIdsInOrder = collectLayoutLeafIdsInOrder(inputRoot)
  const preferredLeafIdsInOrder = collectLayoutLeafIdsInOrder(preferredLayout?.root)
  // Why the uniqueness check: a preferred layout that repeats a UUID would hand two input leaves the
  // same id, collapsing their pty/buffer/scrollback/title records onto one key.
  const usePreferredLeafIds =
    preferredLeafIdsInOrder.length === inputLeafIdsInOrder.length &&
    new Set(preferredLeafIdsInOrder).size === preferredLeafIdsInOrder.length
  const leafIdByInputLeafId = new Map<string, string>()
  // Why pre-seeded: a stable leaf later in the input keeps its own id, so handing that id to an
  // earlier non-terminal leaf would recreate the duplicate this pass exists to remove.
  const claimedLeafIds = new Set(
    inputLeafIdsInOrder.filter((leafId) => counts.get(leafId) === 1 && isTerminalLeafId(leafId))
  )
  for (const [index, leafId] of inputLeafIdsInOrder.entries()) {
    const count = counts.get(leafId) ?? 0
    if (count !== 1 || leafIdByInputLeafId.has(leafId)) {
      changed = true
      continue
    }
    if (isTerminalLeafId(leafId)) {
      leafIdByInputLeafId.set(leafId, leafId)
      claimedLeafIds.add(leafId)
      continue
    }
    changed = true
    const preferredLeafId = usePreferredLeafIds ? preferredLeafIdsInOrder[index] : undefined
    const nextLeafId =
      preferredLeafId && isTerminalLeafId(preferredLeafId) && !claimedLeafIds.has(preferredLeafId)
        ? preferredLeafId
        : randomUUID()
    claimedLeafIds.add(nextLeafId)
    leafIdByInputLeafId.set(leafId, nextLeafId)
  }
  const root = changed
    ? cloneLayoutWithLeafIds(inputRoot, leafIdByInputLeafId, duplicatedInputLeafIds)
    : inputRoot
  const activeLeafId =
    snapshot.activeLeafId && !duplicatedInputLeafIds.has(snapshot.activeLeafId)
      ? (leafIdByInputLeafId.get(snapshot.activeLeafId) ?? firstLayoutLeafId(root))
      : snapshot.activeLeafId === null
        ? null
        : firstLayoutLeafId(root)
  const expandedLeafId =
    snapshot.expandedLeafId && !duplicatedInputLeafIds.has(snapshot.expandedLeafId)
      ? (leafIdByInputLeafId.get(snapshot.expandedLeafId) ?? null)
      : null
  const chatLeafId =
    snapshot.chatLeafId && !duplicatedInputLeafIds.has(snapshot.chatLeafId)
      ? (leafIdByInputLeafId.get(snapshot.chatLeafId) ?? null)
      : null
  const ptyIdsByLeafId = remapLeafRecordForPersistence(
    snapshot.ptyIdsByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const buffersByLeafId = remapLeafRecordForPersistence(
    snapshot.buffersByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const scrollbackRefsByLeafId = remapLeafRecordForPersistence(
    snapshot.scrollbackRefsByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const titlesByLeafId = remapLeafRecordForPersistence(
    snapshot.titlesByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const recordsChanged =
    !leafRecordEquivalent(snapshot.ptyIdsByLeafId, ptyIdsByLeafId) ||
    !leafRecordEquivalent(snapshot.buffersByLeafId, buffersByLeafId) ||
    !leafRecordEquivalent(snapshot.scrollbackRefsByLeafId, scrollbackRefsByLeafId) ||
    !leafRecordEquivalent(snapshot.titlesByLeafId, titlesByLeafId)
  const metadataChanged =
    activeLeafId !== snapshot.activeLeafId ||
    expandedLeafId !== snapshot.expandedLeafId ||
    chatLeafId !== (snapshot.chatLeafId ?? null)
  if (!changed && !recordsChanged && !metadataChanged) {
    return { snapshot, changed: false, leafIdByInputLeafId }
  }
  const {
    ptyIdsByLeafId: _oldPtyIdsByLeafId,
    buffersByLeafId: _oldBuffersByLeafId,
    scrollbackRefsByLeafId: _oldScrollbackRefsByLeafId,
    titlesByLeafId: _oldTitlesByLeafId,
    chatLeafId: _oldChatLeafId,
    ...snapshotWithoutLeafRecords
  } = snapshot
  return {
    snapshot: {
      ...snapshotWithoutLeafRecords,
      root,
      activeLeafId,
      expandedLeafId,
      ...(chatLeafId ? { chatLeafId } : {}),
      ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
      ...(buffersByLeafId ? { buffersByLeafId } : {}),
      ...(scrollbackRefsByLeafId ? { scrollbackRefsByLeafId } : {}),
      ...(titlesByLeafId ? { titlesByLeafId } : {})
    },
    changed: true,
    leafIdByInputLeafId
  }
}
