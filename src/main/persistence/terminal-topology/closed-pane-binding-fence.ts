// Layout-owner builds fence removed panes against late spawns that would recreate missing membership.

import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'

// Five minutes covers credential/connect/relay waits; unique pane IDs make longer fences harmless apart from memory.
export const CLOSED_PANE_BINDING_FENCE_MS = 5 * 60_000

const closedAtByPaneKey = new Map<string, number>()

type SessionsRead = {
  hostIds: () => readonly ExecutionHostId[]
  getSession: (hostId: ExecutionHostId) => WorkspaceSessionState | null | undefined
}

type Fence = { sessions: SessionsRead; fences: boolean }

function paneKeysIn(
  hostIds: readonly ExecutionHostId[],
  getSession: SessionsRead['getSession']
): Set<string> {
  const keys = new Set<string>()
  for (const hostId of hostIds) {
    const layouts = getSession(hostId)?.terminalLayoutsByTabId ?? {}
    for (const [tabId, layout] of Object.entries(layouts)) {
      if (layout?.root) {
        for (const leafId of collectLayoutLeafIdsInOrder(layout.root)) {
          keys.add(`${tabId}:${leafId}`)
        }
      }
    }
  }
  return keys
}

/** Wrap only layout-owner mutations; switch-off builds must not even evaluate fence. */
export function fencedIfLayoutOwner<V>(
  fence: () => Fence | null,
  mutate: () => DurableProfileStateMutation<V>
): () => DurableProfileStateMutation<V> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return mutate
  }
  return () => {
    const plan = fence()
    return plan ? fencingRemovedPanes(plan.sessions, plan.fences, mutate) : mutate()
  }
}

/** Close/take-back writes add fences; other partition writes only lift them. */
export function partitionsFence(
  hostIds: readonly ExecutionHostId[],
  getSession: SessionsRead['getSession'],
  fences: boolean
): Fence {
  return { sessions: { hostIds: () => hostIds, getSession }, fences }
}

/** Layout closes fence, creates lift, other commands leave fences unchanged. */
export function layoutCommandFence(
  type: LayoutCommand['type'],
  hostIds: readonly ExecutionHostId[],
  getSession: SessionsRead['getSession']
): Fence | null {
  if (type === 'closePane' || type === 'closeTabs') {
    return partitionsFence(hostIds, getSession, true)
  }
  if (type === 'createTerminalTab' || type === 'splitPane') {
    return partitionsFence(hostIds, getSession, false)
  }
  return null
}

/** Fence removals, lift explicit recreations, and restore changed fences on rollback. */
function fencingRemovedPanes<V>(
  sessions: SessionsRead,
  fences: boolean,
  write: () => DurableProfileStateMutation<V>
): DurableProfileStateMutation<V> {
  // Capture partitions before a close can remove its own holder.
  const hostIds = [...sessions.hostIds()]
  const before = paneKeysIn(hostIds, sessions.getSession)
  const result = write()
  const after = paneKeysIn(hostIds, sessions.getSession)
  const now = Date.now()
  const changed = new Map<string, number | undefined>()
  const set = (paneKey: string, closedAt: number | undefined): void => {
    if (!changed.has(paneKey)) {
      changed.set(paneKey, closedAtByPaneKey.get(paneKey))
    }
    if (closedAt === undefined) {
      closedAtByPaneKey.delete(paneKey)
    } else {
      closedAtByPaneKey.set(paneKey, closedAt)
    }
  }
  for (const [paneKey, closedAt] of closedAtByPaneKey) {
    if (
      (after.has(paneKey) && !before.has(paneKey)) ||
      now - closedAt >= CLOSED_PANE_BINDING_FENCE_MS
    ) {
      set(paneKey, undefined)
    }
  }
  if (fences) {
    for (const paneKey of before) {
      if (!after.has(paneKey)) {
        set(paneKey, now)
      }
    }
  }
  if (changed.size === 0 || !result.rollback) {
    return result
  }
  const rollback = result.rollback
  return {
    ...result,
    rollback: () => {
      rollback()
      for (const [paneKey, closedAt] of changed) {
        if (closedAt === undefined) {
          closedAtByPaneKey.delete(paneKey)
        } else {
          closedAtByPaneKey.set(paneKey, closedAt)
        }
      }
    }
  }
}

export function isClosedPaneFenced(paneKey: string): boolean {
  const closedAt = closedAtByPaneKey.get(paneKey)
  if (closedAt === undefined) {
    return false
  }
  if (Date.now() - closedAt >= CLOSED_PANE_BINDING_FENCE_MS) {
    closedAtByPaneKey.delete(paneKey)
    return false
  }
  return true
}

export function _resetClosedPaneFencesForTests(): void {
  closedAtByPaneKey.clear()
}
