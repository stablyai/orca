import { nativeSessionReferences } from './session-dependency-native.test-fixture'
import { SESSION_MAP_FIELDS } from '../../../shared/session-change-set'
import {
  SessionUnitIndex,
  type SessionReferenceKind,
  type SessionUnitAddress
} from '../../../shared/session-unit-index'
import { SessionUnitReader, type SessionUnitSelection } from '../../../shared/session-unit-reader'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { reduceSessionIdentityMove } from '../tracking-repos/session-identity-reduction'
import {
  reduceSessionOwnerRemoval,
  reduceSessionRepoRemoval
} from '../restoring-sessions/session-owner-reduction'
import { reducePtyBinding } from './pty-binding-session-update'
import { reducePtyBindingRollback } from './pty-binding-write-rollback'
import type { SessionOperation } from './session-operation'

/** Enumerates native fields for every query; never consults the publication's reverse cache. */
class EnumeratedSessionIndex extends SessionUnitIndex {
  constructor(private readonly source: WorkspaceSessionState) {
    super(source)
  }

  override references(kind: SessionReferenceKind, id: string): readonly SessionUnitAddress[] {
    const selected: SessionUnitAddress[] = []
    for (const field of SESSION_MAP_FIELDS) {
      for (const key of Object.keys(this.source[field] ?? {})) {
        if (nativeSessionReferences(this.source, field, key).get(kind)?.has(id)) {
          selected.push({ field, key })
        }
      }
    }
    return selected
  }
}

export function fullSessionSelection(reader: SessionUnitReader): SessionUnitSelection {
  const candidate = reader.snapshot()
  return new Map(
    SESSION_MAP_FIELDS.map((field) => [
      field,
      new Set([...Object.keys(reader.prior[field] ?? {}), ...Object.keys(candidate[field] ?? {})])
    ])
  )
}

/** Full adapter calls shared kernels over independently enumerated native input, without the operation runner. */
export function enumerateSessionOperation(
  root: WorkspaceSessionState,
  operation: SessionOperation
): WorkspaceSessionState {
  const reader = new SessionUnitReader(root, new EnumeratedSessionIndex(root))
  switch (operation.type) {
    case 'removeRepo':
      reduceSessionRepoRemoval(reader, operation.repoId)
      break
    case 'removeOwners':
      for (const owner of operation.owners) {
        reduceSessionOwnerRemoval(reader, owner, operation.advanceRevision)
      }
      break
    case 'moveOwner':
      reduceSessionIdentityMove(reader, operation.oldId, operation.newId)
      break
    case 'bindPty':
      reducePtyBinding(reader, operation.binding, operation.owner, operation.paneKey)
      break
    case 'rollbackPty':
      reducePtyBindingRollback(reader, operation.staged, operation.binding)
      break
    case 'retirePty': {
      const next = structuredClone(root)
      const layout = next.terminalLayoutsByTabId[operation.tabId]
      if (layout?.ptyIdsByLeafId?.[operation.leafId] !== operation.ptyId) {
        return next
      }
      delete layout.ptyIdsByLeafId[operation.leafId]
      next.terminalPtyIncarnationsByPaneKey = { ...next.terminalPtyIncarnationsByPaneKey }
      delete next.terminalPtyIncarnationsByPaneKey[`${operation.tabId}:${operation.leafId}`]
      for (const tab of next.tabsByWorktree[operation.owner] ?? []) {
        if (tab.id === operation.tabId && tab.ptyId === operation.ptyId) {
          tab.ptyId = null
        }
      }
      return next
    }
  }
  return reader.snapshot()
}
