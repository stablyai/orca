import { randomUUID } from 'node:crypto'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'

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

export function collectLayoutLeafIdsInOrder(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectLayoutLeafIdsInOrder(node.first), ...collectLayoutLeafIdsInOrder(node.second)]
}

export function firstLayoutLeafId(node: TerminalPaneLayoutNode | null): string | null {
  if (!node) {
    return null
  }
  return node.type === 'leaf' ? node.leafId : firstLayoutLeafId(node.first)
}

export function layoutContainsLeafId(node: TerminalPaneLayoutNode | null, leafId: string): boolean {
  if (!node) {
    return false
  }
  if (node.type === 'leaf') {
    return node.leafId === leafId
  }
  return layoutContainsLeafId(node.first, leafId) || layoutContainsLeafId(node.second, leafId)
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
  let inputSnapshot = snapshot
  let changed = false
  if (!inputSnapshot.root) {
    if (!preferredLayout?.root) {
      return { snapshot, changed: false, leafIdByInputLeafId: new Map() }
    }
    const root = cloneLayoutNode(preferredLayout.root)
    const rootLeafIds = new Set(collectLayoutLeafIdsInOrder(root))
    const activeLeafId =
      (inputSnapshot.activeLeafId && rootLeafIds.has(inputSnapshot.activeLeafId)
        ? inputSnapshot.activeLeafId
        : null) ??
      (preferredLayout.activeLeafId && rootLeafIds.has(preferredLayout.activeLeafId)
        ? preferredLayout.activeLeafId
        : null) ??
      firstLayoutLeafId(root)
    const expandedLeafId =
      (inputSnapshot.expandedLeafId && rootLeafIds.has(inputSnapshot.expandedLeafId)
        ? inputSnapshot.expandedLeafId
        : null) ??
      (preferredLayout.expandedLeafId && rootLeafIds.has(preferredLayout.expandedLeafId)
        ? preferredLayout.expandedLeafId
        : null)
    inputSnapshot = { ...inputSnapshot, root, activeLeafId, expandedLeafId }
    // Why: a debounced renderer writer can still hold the createTab-era empty layout after the UUID root was sync-flushed.
    changed = true
  }
  const inputRoot = inputSnapshot.root
  if (!inputRoot) {
    return { snapshot, changed: false, leafIdByInputLeafId: new Map() }
  }
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
    inputSnapshot.activeLeafId && !duplicatedInputLeafIds.has(inputSnapshot.activeLeafId)
      ? (leafIdByInputLeafId.get(inputSnapshot.activeLeafId) ?? firstLayoutLeafId(root))
      : inputSnapshot.activeLeafId === null
        ? null
        : firstLayoutLeafId(root)
  const expandedLeafId =
    inputSnapshot.expandedLeafId && !duplicatedInputLeafIds.has(inputSnapshot.expandedLeafId)
      ? (leafIdByInputLeafId.get(inputSnapshot.expandedLeafId) ?? null)
      : null
  const ptyIdsByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.ptyIdsByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const buffersByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.buffersByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const scrollbackRefsByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.scrollbackRefsByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const titlesByLeafId = remapLeafRecordForPersistence(
    inputSnapshot.titlesByLeafId,
    leafIdByInputLeafId,
    duplicatedInputLeafIds
  )
  const recordsChanged =
    !leafRecordEquivalent(inputSnapshot.ptyIdsByLeafId, ptyIdsByLeafId) ||
    !leafRecordEquivalent(inputSnapshot.buffersByLeafId, buffersByLeafId) ||
    !leafRecordEquivalent(inputSnapshot.scrollbackRefsByLeafId, scrollbackRefsByLeafId) ||
    !leafRecordEquivalent(inputSnapshot.titlesByLeafId, titlesByLeafId)
  const metadataChanged =
    activeLeafId !== inputSnapshot.activeLeafId || expandedLeafId !== inputSnapshot.expandedLeafId
  if (!changed && !recordsChanged && !metadataChanged) {
    return { snapshot, changed: false, leafIdByInputLeafId }
  }
  const {
    ptyIdsByLeafId: _oldPtyIdsByLeafId,
    buffersByLeafId: _oldBuffersByLeafId,
    scrollbackRefsByLeafId: _oldScrollbackRefsByLeafId,
    titlesByLeafId: _oldTitlesByLeafId,
    ...snapshotWithoutLeafRecords
  } = inputSnapshot
  return {
    snapshot: {
      ...snapshotWithoutLeafRecords,
      root,
      activeLeafId,
      expandedLeafId,
      ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {}),
      ...(buffersByLeafId ? { buffersByLeafId } : {}),
      ...(scrollbackRefsByLeafId ? { scrollbackRefsByLeafId } : {}),
      ...(titlesByLeafId ? { titlesByLeafId } : {})
    },
    changed: true,
    leafIdByInputLeafId
  }
}
