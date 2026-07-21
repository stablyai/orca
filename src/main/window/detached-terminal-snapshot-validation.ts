import type {
  DetachedTerminalOpenSnapshot,
  DetachedTerminalSnapshot
} from '../../shared/detached-terminal-window'
import type { TerminalPaneLayoutNode } from '../../shared/types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { getPtyIdForPaneKey } from '../ipc/pty'
import { trustedRendererRegistry } from './trusted-renderer-registry'
import { paneOwnershipRegistry } from './pane-ownership-registry'

export type ValidatedDetachedSnapshot = {
  snapshot: DetachedTerminalSnapshot
  paneKeysByPtyId: Map<string, string>
}

export function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function collectLeafIds(
  node: TerminalPaneLayoutNode | null | undefined,
  leafIds: string[] = []
): string[] {
  if (!node) {
    return leafIds
  }
  if (node.type === 'leaf') {
    leafIds.push(node.leafId)
    return leafIds
  }
  collectLeafIds(node.first, leafIds)
  collectLeafIds(node.second, leafIds)
  return leafIds
}

function layoutContainsGroup(
  node: DetachedTerminalOpenSnapshot['groupLayout'],
  groupId: string
): boolean {
  if (node.type === 'leaf') {
    return node.groupId === groupId
  }
  return layoutContainsGroup(node.first, groupId) || layoutContainsGroup(node.second, groupId)
}

export function validateDetachedTerminalSnapshot(
  worktreeId: string,
  tabId: string,
  snapshot: DetachedTerminalOpenSnapshot
): ValidatedDetachedSnapshot | null {
  if (
    snapshot.worktree.id !== worktreeId ||
    snapshot.terminalTab.id !== tabId ||
    snapshot.terminalTab.worktreeId !== worktreeId ||
    snapshot.unifiedTab.entityId !== tabId ||
    snapshot.unifiedTab.worktreeId !== worktreeId ||
    snapshot.unifiedTab.contentType !== 'terminal' ||
    snapshot.unifiedTab.groupId !== snapshot.group.id ||
    snapshot.group.worktreeId !== worktreeId ||
    snapshot.group.activeTabId !== snapshot.unifiedTab.id ||
    snapshot.activeGroupId !== snapshot.group.id ||
    snapshot.activeTabId !== snapshot.unifiedTab.id ||
    !layoutContainsGroup(snapshot.groupLayout, snapshot.group.id)
  ) {
    return null
  }

  const layout = snapshot.terminalLayout
  const leafIds = collectLeafIds(layout.root)
  const leafIdSet = new Set(leafIds)
  const ptyIdsByLeafId = layout.ptyIdsByLeafId ?? {}
  const validatedPtyIds: string[] = []
  const paneKeysByPtyId = new Map<string, string>()

  for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId)) {
    if (!leafIdSet.has(leafId) || !ptyId) {
      return null
    }
    const paneKey = makePaneKey(tabId, leafId)
    if (getPtyIdForPaneKey(paneKey) !== ptyId) {
      return null
    }
    if (!validatedPtyIds.includes(ptyId)) {
      validatedPtyIds.push(ptyId)
      paneKeysByPtyId.set(ptyId, paneKey)
    }
  }

  if (snapshot.terminalTab.ptyId && !validatedPtyIds.includes(snapshot.terminalTab.ptyId)) {
    if (leafIds.length !== 1) {
      return null
    }
    const leafId = leafIds[0]
    const paneKey = makePaneKey(tabId, leafId)
    if (getPtyIdForPaneKey(paneKey) !== snapshot.terminalTab.ptyId) {
      return null
    }
    validatedPtyIds.push(snapshot.terminalTab.ptyId)
    paneKeysByPtyId.set(snapshot.terminalTab.ptyId, paneKey)
  }

  if (validatedPtyIds.length === 0) {
    return null
  }

  return {
    snapshot: { ...snapshot, ptyIds: validatedPtyIds },
    paneKeysByPtyId
  }
}

function senderCanDetachPty(sender: Electron.WebContents, ptyId: string): boolean {
  return (
    trustedRendererRegistry.has(sender.id, 'pty') &&
    !sender.isDestroyed?.() &&
    paneOwnershipRegistry.senderOwnsPty(sender, ptyId)
  )
}

export function senderCanDetachSnapshot(
  sender: Electron.WebContents,
  validated: ValidatedDetachedSnapshot
): boolean {
  return validated.snapshot.ptyIds.every((ptyId) => senderCanDetachPty(sender, ptyId))
}
