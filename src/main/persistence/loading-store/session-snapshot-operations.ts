import { workspaceSessionPatchNeedsFullNormalization } from './terminal-session-cleanup'
import {
  SessionUnitReader,
  selectSessionUnits,
  type SessionEntry
} from '../../../shared/session-unit-reader'
import {
  SESSION_MAP_FIELDS,
  isSessionMapField,
  type SessionPatchAck
} from '../../../shared/session-change-set'
import { reduceWindowSessionPatch, type SessionWindowAdmission } from '../window-save-view'
import {
  publishWorkspaceSessionSnapshot,
  setLocalWorkspaceSession
} from './workspace-session-snapshot-publication'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'

import type { StoreRuntimeState } from './store-runtime-state'
import {
  type SessionHostPartitionOperations,
  resolveHostId,
  setHostWorkspaceSession,
  withRequiredWorkspaceSessionMaps
} from './session-host-partitions'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import { type WriteSchedulingOperations, scheduleSave } from './write-scheduling'

import { keepWslMoveFrozenSessionsForStore } from '../moving-wsl-projects/wsl-move-session-freeze'

import { orderTerminalRowsByTabGroups } from '../../../shared/workspace-layout/terminal-row-order'
import { publishSessionReplacement, sessionPublication } from './session-publication'

import { validateSessionPatch } from '../../../shared/session-patch-validation'

type SessionSnapshotOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'durableMutationPhase'
  | 'pendingSnapshotFileWork'
  | 'profileMaintenancePending'
  | 'quitFlushStarted'
  | 'state'
  | 'terminalScrollbackSnapshotStorage'
  | 'retainedScrollbackRefsByMigrationId'
  | 'writesFrozen'
>

const sessionSnapshotOperationsContext = Symbol('SessionSnapshotOperations')
type SessionSnapshotOperationsContext = {
  runtime: SessionSnapshotOperationsRuntime
  sessions: SessionHostPartitionOperations
  bindingRecovery: TerminalBindingRecoveryOperations
  scheduling: WriteSchedulingOperations
}

export class SessionSnapshotOperations {
  readonly [sessionSnapshotOperationsContext]: SessionSnapshotOperationsContext

  constructor(
    runtime: SessionSnapshotOperationsRuntime,
    sessions: SessionHostPartitionOperations,
    bindingRecovery: TerminalBindingRecoveryOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[sessionSnapshotOperationsContext] = { runtime, sessions, bindingRecovery, scheduling }
  }

  setWorkspaceSession(session: PersistedState['workspaceSession'], hostId?: string | null): void {
    const resolved = resolveHostId(hostId)
    const { runtime } = this[sessionSnapshotOperationsContext]
    if (runtime.durableMutationPhase === 'rollback') {
      this.assertSnapshotAdmission(true)
      // The fieldwise rollback already preserves newer edits; renderer rebasing would undo it.
      this.publishSession(
        resolved === LOCAL_EXECUTION_HOST_ID
          ? keepWslMoveFrozenSessionsForStore(session, runtime.state.workspaceSession)
          : session,
        resolved
      )
      return
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this.assertSnapshotAdmission(true)
      setLocalWorkspaceSession(this, session)
      return
    }
    setHostWorkspaceSession(this[sessionSnapshotOperationsContext].sessions, resolved, session)
  }

  stageWorkspaceSessionBeforeUnload(
    session: PersistedState['workspaceSession'],
    hostId?: string | null
  ): void {
    const resolved = resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this.assertSnapshotAdmission()
      setLocalWorkspaceSession(this, session, true)
      return
    }
    setHostWorkspaceSession(this[sessionSnapshotOperationsContext].sessions, resolved, session)
  }

  patchWorkspaceSession(
    patch: WorkspaceSessionPatch,
    hostId?: string | null,
    window?: SessionWindowAdmission
  ): SessionPatchAck {
    const resolved = resolveHostId(hostId)
    validateSessionPatch(patch)
    const context = this[sessionSnapshotOperationsContext]
    const publication = sessionPublication(context.runtime.state)
    const partitionGeneration = publication.generation(resolved)
    if (
      patch.expectedPartitionGeneration !== undefined &&
      patch.expectedPartitionGeneration !== partitionGeneration
    ) {
      return { applied: false, reason: 'generationChanged', partitionGeneration }
    }
    this.assertSnapshotAdmission(true)
    const { root, index } = publication.partition(resolved)
    const reader = new SessionUnitReader(root, index)
    for (const [field, value] of Object.entries(patch)) {
      if (
        ['mapDeltas', 'membershipDeltas', 'clearFields', 'expectedPartitionGeneration'].includes(
          field
        )
      ) {
        continue
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validation restricts these keys to the session DTO.
      reader.replace(field as keyof WorkspaceSessionState, {
        present: true,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validateSessionPatch admits only session-field values after envelope fields are excluded.
        value: value as WorkspaceSessionState[keyof WorkspaceSessionState]
      })
    }
    for (const field of SESSION_MAP_FIELDS) {
      const delta = patch.mapDeltas?.[field]
      for (const key of delta?.remove ?? []) {
        reader.write(field, key, { present: false, value: undefined })
      }
      for (const key of Object.keys(delta?.set ?? {})) {
        reader.write(field, key, {
          present: true,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validation and the field-keyed delta admit the selected field's entry domain.
          value: delta!.set![key] as SessionEntry<typeof field>
        })
      }
    }
    for (const field of patch.clearFields ?? [])
    // SAFETY: the clear value is chosen from this validated field's DTO category.
    {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the clear value is chosen from this validated field's DTO category.
      reader.replace(field, { present: true, value: clearedSessionField(field) as never })
    }
    for (const field of ['activeWorktreeIdsOnShutdown', 'activeConnectionIdsAtShutdown'] as const) {
      const delta = patch.membershipDeltas?.[field]
      if (!delta) {
        continue
      }
      const remove = new Set(delta.remove ?? [])
      const members = new Set((reader.field(field).value ?? []).filter((id) => !remove.has(id)))
      for (const id of delta.add ?? []) {
        members.add(id)
      }
      reader.replace(field, { present: true, value: [...members] })
    }
    const full = Object.keys(patch).some(isSessionMapField)
    const selected = selectSessionUnits(reader, [], full)
    if (window) {
      reduceWindowSessionPatch(reader, resolved, selected, window, full)
    }
    publishWorkspaceSessionSnapshot(
      context,
      resolved,
      reader,
      full,
      false,
      selected,
      workspaceSessionPatchNeedsFullNormalization(patch)
    )
    return { applied: true, partitionGeneration: publication.generation(resolved) }
  }

  private publishSession(session: WorkspaceSessionState, hostId: ExecutionHostId): void {
    session = orderTerminalRowsByTabGroups(session)
    const { runtime, scheduling } = this[sessionSnapshotOperationsContext]
    publishSessionReplacement(
      runtime.state,
      hostId,
      withRequiredWorkspaceSessionMaps(session),
      runtime.durableMutationPhase === 'rollback' ? 'rollback' : 'fullReplacement'
    )
    scheduleSave(
      scheduling,
      hostId === LOCAL_EXECUTION_HOST_ID ? ['workspaceSession'] : ['workspaceSessionsByHostId'],
      hostId
    )
  }

  private assertSnapshotAdmission(allowAdmittedMutation = false): void {
    const { runtime } = this[sessionSnapshotOperationsContext]
    if (
      runtime.writesFrozen ||
      ((runtime.profileMaintenancePending || runtime.quitFlushStarted) &&
        !(allowAdmittedMutation && runtime.durableMutationPhase !== null))
    ) {
      throw new Error('Profile maintenance or finalization is blocking new terminal snapshot work')
    }
  }
}

export function getSessionSnapshotOperationsContext(owner: SessionSnapshotOperations) {
  return owner[sessionSnapshotOperationsContext]
}

function clearedSessionField(field: keyof WorkspaceSessionState): unknown {
  if (isSessionMapField(field)) {
    return {}
  }
  if (
    field === 'browserUrlHistory' ||
    field === 'workspaceDocHistory' ||
    field === 'activeWorktreeIdsOnShutdown' ||
    field === 'activeConnectionIdsAtShutdown'
  ) {
    return []
  }
  return null
}
