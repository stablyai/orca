import { reduceSessionIdentityMove } from '../tracking-repos/session-identity-reduction'
import { reducePtyBindingRollback } from './pty-binding-write-rollback'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import type { SessionUnitIndex } from '../../../shared/session-unit-index'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  reduceSessionOwnerRemoval,
  reduceSessionRepoRemoval
} from '../restoring-sessions/session-owner-reduction'
import type { PersistPtyBindingArgs } from './pty-binding-args'
import { reducePtyBinding } from './pty-binding-session-update'
import { publishSessionChanges, sessionPublication } from './session-publication'

export type SessionOperation =
  | { type: 'removeRepo'; repoId: string }
  | { type: 'moveOwner'; oldId: string; newId: string }
  | { type: 'removeOwners'; owners: readonly string[]; advanceRevision: boolean }
  | {
      type: 'rollbackPty'
      staged: SessionUnitReader
      binding?: { owner: string; tabId: string; leafId: string }
    }
  | { type: 'retirePty'; owner: string; tabId: string; leafId: string; ptyId: string }
  | { type: 'bindPty'; binding: PersistPtyBindingArgs; owner: string; paneKey: string }

type SessionOperationState = Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>

/** Full adapters enumerate their inputs; ordinary operations retain identities before selection. */
export function prepareSessionOperation(
  root: WorkspaceSessionState,
  operation: SessionOperation,
  index: SessionUnitIndex
): SessionUnitReader {
  const reader = new SessionUnitReader(root, index)
  switch (operation.type) {
    case 'removeRepo':
      reduceSessionRepoRemoval(reader, operation.repoId)
      break
    case 'moveOwner':
      reduceSessionIdentityMove(reader, operation.oldId, operation.newId)
      break
    case 'removeOwners':
      for (const owner of operation.owners) {
        reduceSessionOwnerRemoval(reader, owner, operation.advanceRevision)
      }
      break
    case 'rollbackPty':
      reducePtyBindingRollback(reader, operation.staged, operation.binding)
      break
    case 'retirePty': {
      const layout = reader.unit('terminalLayoutsByTabId', operation.tabId).value
      if (!layout || layout.ptyIdsByLeafId?.[operation.leafId] !== operation.ptyId) {
        break
      }
      const remaining = { ...layout.ptyIdsByLeafId }
      delete remaining[operation.leafId]
      reader.write('terminalLayoutsByTabId', operation.tabId, {
        present: true,
        value: { ...layout, ptyIdsByLeafId: remaining }
      })
      reader.write('terminalPtyIncarnationsByPaneKey', `${operation.tabId}:${operation.leafId}`, {
        present: false,
        value: undefined
      })
      reader.reconcileField('terminalPtyIncarnationsByPaneKey', {
        kind: 'replacement',
        present: true,
        explicitEmpty: true
      })
      const tabs = reader.unit('tabsByWorktree', operation.owner).value ?? []
      reader.write('tabsByWorktree', operation.owner, {
        present: true,
        value: tabs.map((tab) =>
          tab.id === operation.tabId && tab.ptyId === operation.ptyId
            ? { ...tab, ptyId: null }
            : tab
        )
      })
      break
    }
    case 'bindPty':
      reducePtyBinding(reader, operation.binding, operation.owner, operation.paneKey)
      break
  }
  return reader
}

export function readSessionOperation(
  state: SessionOperationState,
  hostId: ExecutionHostId
): SessionUnitReader {
  const { root, index } = sessionPublication(state).partition(hostId)
  return new SessionUnitReader(root, index)
}

export function runSessionOperation(
  state: SessionOperationState,
  hostId: ExecutionHostId,
  operation: SessionOperation
): SessionUnitReader {
  const { root, index } = sessionPublication(state).partition(hostId)
  const prepared = prepareSessionOperation(root, operation, index)
  publishSessionChanges(
    state,
    hostId,
    prepared.prepare({ kind: operation.type === 'rollbackPty' ? 'rollback' : 'authoritative' })
  )
  return prepared
}
