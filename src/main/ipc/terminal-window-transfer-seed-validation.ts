import { Buffer } from 'node:buffer'
import { isDeepStrictEqual } from 'node:util'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId
} from '../../shared/execution-host'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../shared/terminal-tab-types'
import type { TerminalWindowTransferSeed } from '../../shared/terminal-window-transfer'
import { TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT } from '../../shared/terminal-scrollback-limits'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { isWorkspaceKey, worktreeWorkspaceKey } from '../../shared/workspace-scope'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const MAX_LAYOUT_ENTRIES = 1024
const MAX_LAYOUT_KEY_LENGTH = 4_096

function collectLayoutLeaves(root: unknown): Set<string> | null {
  if (!isRecord(root)) {
    return null
  }
  const leaves = new Set<string>()
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }]
  let count = 0
  while (stack.length > 0) {
    const { node: raw, depth } = stack.pop()!
    if (!isRecord(raw) || depth > 64 || ++count > MAX_LAYOUT_ENTRIES) {
      return null
    }
    const node = raw as Partial<TerminalPaneLayoutNode>
    if (node.type === 'leaf') {
      if (
        typeof node.leafId !== 'string' ||
        node.leafId.length === 0 ||
        node.leafId.length > MAX_LAYOUT_KEY_LENGTH ||
        leaves.has(node.leafId)
      ) {
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

function isLeafStringRecord(
  value: unknown,
  leaves: ReadonlySet<string> | null,
  recordLeafIds: Set<string>,
  maxValueLength: number
): boolean {
  if (value === undefined) {
    return true
  }
  if (!isRecord(value)) {
    return false
  }
  for (const leafId in value) {
    if (!Object.hasOwn(value, leafId)) {
      continue
    }
    const item = value[leafId]
    recordLeafIds.add(leafId)
    if (
      recordLeafIds.size > MAX_LAYOUT_ENTRIES ||
      leafId.length === 0 ||
      leafId.length > MAX_LAYOUT_KEY_LENGTH ||
      (leaves && !leaves.has(leafId)) ||
      typeof item !== 'string' ||
      item.length > maxValueLength ||
      Buffer.byteLength(item) > maxValueLength
    ) {
      return false
    }
  }
  return true
}

function isTransferLayout(value: unknown): boolean {
  if (!isRecord(value)) {
    return false
  }
  const rootless = value.root === null
  const leaves = rootless ? null : collectLayoutLeaves(value.root)
  const recordLeafIds = new Set<string>()
  return Boolean(
    (rootless || leaves) &&
    (value.activeLeafId === null ||
      (typeof value.activeLeafId === 'string' &&
        value.activeLeafId.length > 0 &&
        value.activeLeafId.length <= MAX_LAYOUT_KEY_LENGTH &&
        (!leaves || leaves.has(value.activeLeafId)))) &&
    (value.expandedLeafId === null ||
      (typeof value.expandedLeafId === 'string' &&
        value.expandedLeafId.length > 0 &&
        value.expandedLeafId.length <= MAX_LAYOUT_KEY_LENGTH &&
        (!leaves || leaves.has(value.expandedLeafId)))) &&
    isLeafStringRecord(value.ptyIdsByLeafId, leaves, recordLeafIds, MAX_LAYOUT_KEY_LENGTH) &&
    isLeafStringRecord(
      value.buffersByLeafId,
      leaves,
      recordLeafIds,
      TERMINAL_SCROLLBACK_SESSION_BUFFER_BYTE_LIMIT
    ) &&
    isLeafStringRecord(
      value.scrollbackRefsByLeafId,
      leaves,
      recordLeafIds,
      MAX_LAYOUT_KEY_LENGTH
    ) &&
    isLeafStringRecord(value.titlesByLeafId, leaves, recordLeafIds, MAX_LAYOUT_KEY_LENGTH)
  )
}

export function isTerminalWindowTransferSeed(value: unknown): value is TerminalWindowTransferSeed {
  const seed = isRecord(value) ? value : null
  const tab = seed && isRecord(seed.tab) ? seed.tab : null
  const group = seed && isRecord(seed.group) ? seed.group : null
  const repo = seed && isRecord(seed.repo) ? seed.repo : null
  const ptyIds = seed?.ptyIds
  const host = typeof seed?.hostId === 'string' ? parseExecutionHostId(seed.hostId) : null
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
    repo.id.length > 0 &&
    host &&
    getRepoExecutionHostId(repo as TerminalWindowTransferSeed['repo']) === host.id &&
    (host.kind !== 'ssh' ||
      ptyIds.every(
        (id) => typeof id === 'string' && parseAppSshPtyId(id)?.connectionId === host.targetId
      ))
  )
}

export function sessionMatchesTerminalWindowTarget(
  state: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed
): boolean {
  const workspaceKey = state.activeWorkspaceKey
    ? state.activeWorkspaceKey
    : state.activeWorktreeId
      ? isWorkspaceKey(state.activeWorktreeId)
        ? state.activeWorktreeId
        : worktreeWorkspaceKey(state.activeWorktreeId)
      : null
  const hostId =
    normalizeExecutionHostId(state.activeWorkspaceExecutionHostId) ?? LOCAL_EXECUTION_HOST_ID
  return workspaceKey === seed.canonicalWorkspaceKey && hostId === seed.hostId
}

function getTerminalPtyIds(tab: TerminalTab, layout: TerminalLayoutSnapshot): string[] | null {
  const values = [tab.ptyId, ...Object.values(layout.ptyIdsByLeafId ?? {})].filter(
    (id): id is string => id !== null
  )
  return values.length > 0 && values.every((id) => id.length > 0) ? [...new Set(values)] : null
}

export function getTerminalWindowTransferSourceError(
  state: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed,
  owns: (ptyId: string) => boolean
): string | null {
  const tab = state.tabsByWorktree[seed.worktreeId]?.find(({ id }) => id === seed.tabId)
  const layout = state.terminalLayoutsByTabId[seed.tabId]
  if (!tab || !layout) {
    return 'terminal_transfer_source_missing'
  }
  if (!sessionMatchesTerminalWindowTarget(state, seed)) {
    return 'terminal_transfer_source_mismatch'
  }
  const ptyIds = getTerminalPtyIds(tab, layout)
  const samePtys =
    ptyIds?.length === seed.ptyIds.length && ptyIds.every((id) => seed.ptyIds.includes(id))
  const groups = state.tabGroups?.[seed.worktreeId]
  const group = groups?.find(({ tabOrder }) => tabOrder.includes(seed.tabId))
  if (
    !ptyIds ||
    !samePtys ||
    !isDeepStrictEqual(seed.tab, tab) ||
    !isDeepStrictEqual(seed.layout, layout) ||
    (groups && groups.length > 0 && !isDeepStrictEqual(seed.group, group))
  ) {
    return 'terminal_transfer_source_mismatch'
  }
  return ptyIds.some((id) => !owns(id)) ? 'terminal_transfer_source_not_owner' : null
}
