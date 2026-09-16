import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import { tabRowPtyIdAfterLeafBinding } from './terminal-tab-pty-ownership'

/**
 * Why a reattach can be ineligible. `not_durable` alone means memory already matched but the
 * binding was still waiting in the debounced save — the bucket that says whether skipping the
 * flush on a durable match is enough, or the autosave itself has to move off the main thread.
 */
export type PtyBindingFastLaneMiss =
  | 'split'
  | 'legacy_leaf'
  | 'tab_missing'
  | 'tab_pty'
  | 'layout_missing'
  | 'leaf_absent'
  | 'leaf_pty'
  | 'incarnation'
  | 'tombstone'
  | 'not_durable'

export type PtyBindingFastLaneRequest = {
  tabId: string
  leafId: string
  ptyId: string
  incarnationId?: string
  expectedSourceBinding?: unknown
}

export type PtyBindingFastLaneVerdict = {
  eligible: boolean
  misses: PtyBindingFastLaneMiss[]
}

/**
 * True only when `persistPtyBinding` would change nothing: the requested binding is already the
 * in-memory session's binding and that session is already on disk. Every miss falls through to
 * the write path, so the predicate must be at least as strict as the mutations it stands in for.
 */
export function evaluatePtyBindingFastLane(
  args: PtyBindingFastLaneRequest,
  session: WorkspaceSessionState,
  bindingWorktreeId: string,
  durable: boolean
): PtyBindingFastLaneVerdict {
  const misses: PtyBindingFastLaneMiss[] = []
  const paneKey = `${args.tabId}:${args.leafId}`
  if (args.expectedSourceBinding !== undefined) {
    misses.push('split')
  }
  if (!isTerminalLeafId(args.leafId)) {
    misses.push('legacy_leaf')
  }
  const tab = session.tabsByWorktree?.[bindingWorktreeId]?.find(
    (candidate) => candidate.id === args.tabId
  )
  const layout = session.terminalLayoutsByTabId?.[args.tabId]
  if (!tab) {
    misses.push('tab_missing')
  } else if (
    tab.ptyId !== tabRowPtyIdAfterLeafBinding(tab, layout?.ptyIdsByLeafId, args.leafId, args.ptyId)
  ) {
    misses.push('tab_pty')
  }
  if (!layout || !layout.root) {
    misses.push('layout_missing')
  } else {
    if (!layoutContainsLeafId(layout.root, args.leafId)) {
      misses.push('leaf_absent')
    }
    if (layout.ptyIdsByLeafId?.[args.leafId] !== args.ptyId) {
      misses.push('leaf_pty')
    }
  }
  // Strict: undefined on both sides matches, undefined on one side does not.
  if (session.terminalPtyIncarnationsByPaneKey?.[paneKey] !== args.incarnationId) {
    misses.push('incarnation')
  }
  if (session.terminalSurfaceTombstonesByPaneKey?.[paneKey]) {
    misses.push('tombstone')
  }
  if (!durable) {
    misses.push('not_durable')
  }
  return { eligible: misses.length === 0, misses }
}
