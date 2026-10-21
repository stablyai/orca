// Panes main closed or took back, kept in memory so a terminal start already under way cannot bring
// one back by its late binding (pty-binding-session-update.ts mints a missing pane). Layout-owner
// build only: every caller is behind ORCA_LAYOUT_OWNER_IS_MAIN.

import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'

/**
 * Why 5 min: past the longest a start can wait before it binds. An SSH start may first wait on a
 * credential prompt (SSH_CREDENTIAL_TIMEOUT_MS, 120 s) and a connect (CONNECT_TIMEOUT_MS, 30 s,
 * both ssh-connection-utils.ts), then on its relay request (REQUEST_TIMEOUT_MS, 30 s,
 * ssh-channel-multiplexer.ts); the local daemon admits a spawn within 12 s
 * (MAX_SPAWN_ADMISSION_WINDOW_MS, daemon-terminal-admission.ts). Pane ids are never reused, so a
 * longer fence refuses nothing legitimate; the bound only limits memory.
 */
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

/**
 * Switch point: in a layout-owner build, `mutate` runs through `fencingRemovedPanes` with what `fence`
 * names (null: unfenced). Otherwise it is `mutate` itself; `fence` is never called.
 */
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

/** A write to these partitions: `fences` when it is a close or take-back, else it only lifts. */
export function partitionsFence(
  hostIds: readonly ExecutionHostId[],
  getSession: SessionsRead['getSession'],
  fences: boolean
): Fence {
  return { sessions: { hostIds: () => hostIds, getSession }, fences }
}

/** A window or client layout command: its closes fence, its terminal creates lift; others neither. */
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

/**
 * Runs a write of main's, then fences the panes it removed when `fences` (a close or take-back) and
 * lifts the fence of each pane it newly wrote: a real create under the same id binds as any. A
 * rolled-back write puts back the fences it changed.
 */
function fencingRemovedPanes<V>(
  sessions: SessionsRead,
  fences: boolean,
  write: () => DurableProfileStateMutation<V>
): DurableProfileStateMutation<V> {
  // The partitions as they were before: a tab's close can drop the partition list it came from.
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

/** Whether main closed or took back this pane within the binding window. */
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
