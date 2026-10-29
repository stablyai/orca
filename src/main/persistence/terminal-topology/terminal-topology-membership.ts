import type { SessionMapField } from '../../../shared/session-change-set'
import { type SessionEntry, SessionUnitReader } from '../../../shared/session-unit-reader'

import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { layoutContainsLeafId } from '../restoring-sessions/terminal-layout-normalization'
import {
  publishSessionChanges,
  publishSessionReplacement,
  sessionPublication,
  sessionIndexForRoot
} from '../loading-store/session-publication'

export function advanceTerminalTopologyRevision(
  session: WorkspaceSessionState,
  worktreeId: string
): WorkspaceSessionState {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return {
    ...session,
    terminalTopologyRevisionByRepoId: {
      ...session.terminalTopologyRevisionByRepoId,
      [repoId]: (session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) + 1
    }
  }
}

/** Resolve current ownership after detaches; leaf IDs survive moves while tab IDs do not. */
export function findTerminalTabIdForLeaf(
  session: WorkspaceSessionState | undefined,
  leafId: string
): string | undefined {
  const layouts = session?.terminalLayoutsByTabId
  if (!layouts) {
    return undefined
  }
  const index = session && sessionIndexForRoot(session)
  if (index) {
    return index.references('leaf', leafId).find((unit) => unit.field === 'terminalLayoutsByTabId')
      ?.key
  }
  for (const tabId of Object.keys(layouts)) {
    if (layoutContainsLeafId(layouts[tabId]?.root ?? null, leafId)) {
      return tabId
    }
  }
  return undefined
}

export function hasHostAuthoritativeTerminalMembership(
  session: WorkspaceSessionState | undefined,
  worktreeId: string
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return (
    (session?.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) > 0 ||
    Object.values(session?.terminalSurfaceTombstonesByPaneKey ?? {}).some(
      (tombstone) => tombstone.worktreeId === worktreeId
    )
  )
}

export type TerminalSessionPartition = {
  hostId: ExecutionHostId
  session: WorkspaceSessionState
  prepared?: SessionUnitReader
}

/** Runtime partitions mirror another host; local and SSH own their panes. */
export function isTerminalOwnerPartition(hostId: ExecutionHostId): boolean {
  const kind = parseExecutionHostId(hostId)?.kind
  return kind === 'local' || kind === 'ssh'
}

export function assignWorkspaceSessionPartition(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState | SessionUnitReader
): 'workspaceSession' | 'workspaceSessionsByHostId' {
  // Local belongs only in workspaceSession, never the host-partition map.
  if (session instanceof SessionUnitReader) {
    publishSessionChanges(state, hostId, session.prepare({ kind: 'authoritative' }))
  } else {
    publishSessionReplacement(state, hostId, session)
  }
  return hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
}

/** Restore only the failed operation's units whose versions are still current. */
export function writeRestorableSession(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState | SessionUnitReader,
  markDirty: (domain: 'workspaceSession' | 'workspaceSessionsByHostId') => void,
  relatedViews?: ReadonlyMap<string, { prior: unknown; next: unknown }>
): () => void {
  const publication = sessionPublication(state)
  const event =
    session instanceof SessionUnitReader
      ? publishSessionChanges(
          state,
          hostId,
          session.prepare({ kind: 'authoritative', relatedViews })
        )
      : publishSessionReplacement(state, hostId, session, 'fullReplacement', relatedViews)
  const domain =
    hostId === LOCAL_EXECUTION_HOST_ID ? 'workspaceSession' : 'workspaceSessionsByHostId'
  markDirty(domain)
  const versions = new Map(
    event.units.map((unit) => [
      JSON.stringify([unit.field, unit.key]),
      publication.partition(hostId).versions.get(JSON.stringify([unit.field, unit.key]))
    ])
  )
  return () => {
    const { root, index } = publication.partition(hostId)
    const rollback = new SessionUnitReader(root, index)
    for (const unit of event.units) {
      const id = JSON.stringify([unit.field, unit.key])
      if (publication.partition(hostId).versions.get(id) !== versions.get(id)) {
        continue
      }
      if (unit.key === null) {
        rollback.restoreField(unit.field, unit.priorPresent, unit.prior)
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: keyed receipts retain their map field and value from preparation.
        const field = unit.field as SessionMapField
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receipt retains the original entry type for this map field.
        const value = unit.prior as SessionEntry<typeof field>
        rollback.write(
          field,
          unit.key,
          unit.priorPresent ? { present: true, value } : { present: false, value: undefined }
        )
      }
    }
    publishSessionChanges(state, hostId, rollback.prepare({ kind: 'rollback' }))
    markDirty(domain)
  }
}
