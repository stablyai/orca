// Layout-owner commands and rollback advance generations only for changed bindings, excluding moves/removals.

import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { collectLayoutLeafIdsInOrder } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { bumpPtyBindingGeneration } from '../loading-store/pty-binding-generations'
import type {
  DurableProfileStateMutation,
  StoreRuntimeState
} from '../loading-store/store-runtime-state'

function bindingsOf(
  session: WorkspaceSessionState,
  tabIds: Iterable<string>
): Map<string, string | undefined> {
  return new Map(
    [...tabIds].flatMap((tabId) => {
      const layout = session.terminalLayoutsByTabId?.[tabId]
      return collectLayoutLeafIdsInOrder(layout?.root ?? null).map(
        (leafId) => [leafId, layout?.ptyIdsByLeafId?.[leafId]] as const
      )
    })
  )
}

/** Changed/new bindings on panes retained after the write. */
export function reboundLeafIds(
  before: WorkspaceSessionState,
  after: WorkspaceSessionState,
  tabIds: Iterable<string> = new Set([
    ...Object.keys(before.terminalLayoutsByTabId),
    ...Object.keys(after.terminalLayoutsByTabId)
  ])
): string[] {
  const keys = [...tabIds]
  const was = bindingsOf(before, keys)
  return [...bindingsOf(after, keys)].flatMap(([leafId, ptyId]) => {
    const changed = was.has(leafId) ? was.get(leafId) !== ptyId : ptyId !== undefined
    return changed ? [leafId] : []
  })
}

export function raisingBindingGenerations<T>(
  runtime: Pick<StoreRuntimeState, 'ptyBindingGenerations'>,
  hostIds: readonly ExecutionHostId[],
  getSession: (hostId: ExecutionHostId) => WorkspaceSessionState,
  mutate: () => DurableProfileStateMutation<T>,
  tabIds: (hostId: ExecutionHostId) => Iterable<string>
): () => DurableProfileStateMutation<T> {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    return mutate
  }
  return () => {
    const before = hostIds.map((hostId) => ({
      hostId,
      session: getSession(hostId),
      keys: [...tabIds(hostId)]
    }))
    const result = mutate()
    const rebound = before.flatMap(({ hostId, session, keys }) =>
      reboundLeafIds(session, getSession(hostId), keys).map((leafId) => ({ hostId, leafId }))
    )
    if (rebound.length === 0) {
      return result
    }
    const bump = (): void =>
      rebound.forEach(({ hostId, leafId }) => bumpPtyBindingGeneration(runtime, hostId, leafId))
    bump()
    return {
      ...result,
      rollback: () => {
        result.rollback?.()
        bump()
      }
    }
  }
}
