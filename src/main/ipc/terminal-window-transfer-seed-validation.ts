import { normalizeExecutionHostId } from '../../shared/execution-host'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import type { TerminalWindowTransferSeed } from '../../shared/terminal-window-transfer'
import { isWorkspaceKey } from '../../shared/workspace-scope'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

function collectLayoutLeaves(root: unknown): Set<string> | null {
  if (!isRecord(root)) {
    return null
  }
  const leaves = new Set<string>()
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }]
  let count = 0
  while (stack.length > 0) {
    const { node: raw, depth } = stack.pop()!
    if (!isRecord(raw) || depth > 64 || ++count > 1024) {
      return null
    }
    const node = raw as Partial<TerminalPaneLayoutNode>
    if (node.type === 'leaf') {
      if (typeof node.leafId !== 'string' || node.leafId.length === 0 || leaves.has(node.leafId)) {
        return null
      }
      leaves.add(node.leafId)
      continue
    }
    if (
      node.type !== 'split' ||
      (node.direction !== 'horizontal' && node.direction !== 'vertical') ||
      (node.ratio !== undefined &&
        (typeof node.ratio !== 'number' ||
          !Number.isFinite(node.ratio) ||
          node.ratio < 0 ||
          node.ratio > 1))
    ) {
      return null
    }
    stack.push({ node: node.first, depth: depth + 1 }, { node: node.second, depth: depth + 1 })
  }
  return leaves
}

function isLeafStringRecord(value: unknown, leaves: ReadonlySet<string>): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      Object.entries(value).every(
        ([leafId, item]) => leaves.has(leafId) && typeof item === 'string'
      ))
  )
}

function isTransferLayout(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  const leaves = collectLayoutLeaves(value.root)
  return Boolean(
    leaves &&
    (value.activeLeafId === null ||
      (typeof value.activeLeafId === 'string' && leaves.has(value.activeLeafId))) &&
    (value.expandedLeafId === null ||
      (typeof value.expandedLeafId === 'string' && leaves.has(value.expandedLeafId))) &&
    isLeafStringRecord(value.ptyIdsByLeafId, leaves) &&
    isLeafStringRecord(value.buffersByLeafId, leaves) &&
    isLeafStringRecord(value.scrollbackRefsByLeafId, leaves) &&
    isLeafStringRecord(value.titlesByLeafId, leaves)
  )
}

export function isTerminalWindowTransferSeed(value: unknown): value is TerminalWindowTransferSeed {
  const seed = isRecord(value) ? value : null
  const tab = seed && isRecord(seed.tab) ? seed.tab : null
  const group = seed && isRecord(seed.group) ? seed.group : null
  const repo = seed && isRecord(seed.repo) ? seed.repo : null
  const ptyIds = seed?.ptyIds
  return Boolean(
    seed &&
    typeof seed.tabId === 'string' &&
    seed.tabId.length > 0 &&
    typeof seed.hostId === 'string' &&
    normalizeExecutionHostId(seed.hostId) === seed.hostId &&
    typeof seed.canonicalWorkspaceKey === 'string' &&
    isWorkspaceKey(seed.canonicalWorkspaceKey) &&
    typeof seed.worktreeId === 'string' &&
    seed.worktreeId.length > 0 &&
    tab?.id === seed.tabId &&
    tab.worktreeId === seed.worktreeId &&
    typeof tab.title === 'string' &&
    group?.worktreeId === seed.worktreeId &&
    typeof group.id === 'string' &&
    Array.isArray(group.tabOrder) &&
    group.tabOrder.includes(seed.tabId) &&
    isTransferLayout(seed.layout) &&
    Array.isArray(ptyIds) &&
    ptyIds.length > 0 &&
    new Set(ptyIds).size === ptyIds.length &&
    ptyIds.every((id) => typeof id === 'string' && id.length > 0) &&
    typeof repo?.id === 'string' &&
    repo.id.length > 0
  )
}
