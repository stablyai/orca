import type { PersistedState } from '../../../shared/persisted-state-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { parseOrcadLiveSourceRetirementRecord } from '../../ssh/orcad-live-source-retirement-record'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope
} from './orcad-source-scope'

type RetirementRecord = ReturnType<typeof parseOrcadLiveSourceRetirementRecord>
type JsonRecord = Record<string, unknown>
const same = (left: unknown, right: unknown) =>
  serializeOrcadMigrationValue(left) === serializeOrcadMigrationValue(right)
import {
  isSessionEvidenceObject as object,
  identityFields,
  supportedRow,
  collectRemovedIdentities,
  containsSourcePtyReference
} from './orcad-live-retired-session-fields'

/** Installed-record evidence only; this never licenses installing or rewriting a session. */
export function hasOrcadLiveRetiredSessionAfterState(
  state: PersistedState,
  record: RetirementRecord
): boolean {
  return (
    record.changes.every(
      (change) =>
        change.field === 'workspaceSession' ||
        change.field === 'workspaceSessionsByHostId' ||
        same(state[change.field], change.after === null ? undefined : JSON.parse(change.after))
    ) && hasOrcadLiveRetiredSourceSessionState(state, record)
  )
}

/** Ongoing session fencing does not freeze unrelated catalog collections. */
export function hasOrcadLiveRetiredSourceSessionState(
  state: PersistedState,
  record: RetirementRecord
): boolean {
  const { manifest } = record.release.cutover
  if (state.workspaceSessionsByHostId !== undefined && !object(state.workspaceSessionsByHostId)) {
    return false
  }
  const scope = createOrcadMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload
  })
  const identities = new Set<string>()
  const panes = new Set<string>()
  const sourcePtys = new Set<string>()
  for (const { identity, surfaceBinding } of record.release.cutover.liveTerminalBindings ?? []) {
    identities.add(surfaceBinding.tabId)
    identities.add(identity.incarnationId)
    identities.add(toAppSshPtyId(scope.targetId, identity.terminalId))
    sourcePtys.add(toAppSshPtyId(scope.targetId, identity.terminalId))
    panes.add(`${surfaceBinding.tabId}:${surfaceBinding.leafId}`)
  }
  for (const session of [
    state.workspaceSession,
    ...Object.values(state.workspaceSessionsByHostId ?? {})
  ]) {
    if (session === undefined) {
      continue
    }
    if (!object(session)) {
      return false
    }
    for (const field of [
      'tabsByWorktree',
      'terminalLayoutsByTabId',
      'remoteSessionIdsByTabId',
      'terminalSurfaceTombstonesByPaneKey'
    ] as const) {
      if (containsSourcePtyReference(session[field], sourcePtys, field)) {
        return false
      }
    }
  }
  const pairs: { before: unknown; after: unknown; current: unknown }[] = []
  for (const change of record.changes) {
    if (change.field !== 'workspaceSession' && change.field !== 'workspaceSessionsByHostId') {
      continue
    }
    const before: unknown = change.before === null ? undefined : JSON.parse(change.before)
    const after: unknown = change.after === null ? undefined : JSON.parse(change.after)
    if (change.field === 'workspaceSession') {
      pairs.push({ before, after, current: state.workspaceSession })
    } else if (change.field === 'workspaceSessionsByHostId') {
      if ((before !== undefined && !object(before)) || (after !== undefined && !object(after))) {
        return false
      }
      const previous = (before ?? {}) as JsonRecord
      const expected = (after ?? {}) as JsonRecord
      const current = state.workspaceSessionsByHostId ?? {}
      for (const hostId of new Set([...Object.keys(previous), ...Object.keys(expected)])) {
        if (hostId === scope.hostId || hostId === 'local') {
          pairs.push({
            before: previous[hostId],
            after: expected[hostId],
            current: current[hostId as keyof typeof current]
          })
        } else if (
          !same(previous[hostId], expected[hostId]) &&
          !same(current[hostId as keyof typeof current], expected[hostId])
        ) {
          return false
        }
      }
    }
  }
  const owns = (value: string) => {
    if (isWorktreeHostIdentity(value)) {
      const host = getExecutionHostIdFromWorktreeHostIdentity(value)
      if (host && host !== scope.hostId) {
        return false
      }
    }
    return orcadMigrationOwnerMatchesScope(value, scope)
  }
  for (const { before, after } of pairs) {
    if ((before !== undefined && !object(before)) || (after !== undefined && !object(after))) {
      return false
    }
    if (
      [before, after].some(
        (session) =>
          object(session) &&
          Object.keys(session).some(
            (field) => !Object.hasOwn(WORKSPACE_SESSION_FIELD_OWNERSHIP, field)
          )
      )
    ) {
      return false
    }
    for (const [field, original] of Object.entries((before ?? {}) as JsonRecord)) {
      const expected = (after as JsonRecord | undefined)?.[field]
      if (same(original, expected) || !object(original)) {
        continue
      }
      for (const [key, entry] of Object.entries(original)) {
        if (!object(expected) || !Object.hasOwn(expected, key)) {
          identities.add(key)
          collectRemovedIdentities(entry, identities)
        }
      }
    }
  }
  const sourceReference = (value: unknown, key: string): boolean => {
    if (typeof value === 'string') {
      return (
        (identityFields.has(key) && identities.has(value)) ||
        ((key === 'worktreeId' || key === 'activeWorktreeId' || key === 'activeWorkspaceKey') &&
          owns(value)) ||
        ((key === 'connectionId' || key === 'externalSshTargetId') && value === scope.targetId)
      )
    }
    if (Array.isArray(value)) {
      return value.some(
        (entry) =>
          ((key === 'tabOrder' || key === 'recentTabIds') &&
            typeof entry === 'string' &&
            identities.has(entry)) ||
          sourceReference(entry, key)
      )
    }
    return (
      object(value) &&
      Object.entries(value).some(([nestedKey, entry]) => sourceReference(entry, nestedKey))
    )
  }
  const safeSession = (value: unknown): boolean => {
    if (!object(value)) {
      return value === undefined
    }
    return Object.entries(value).every(([field, entry]) => {
      if (!Object.hasOwn(WORKSPACE_SESSION_FIELD_OWNERSHIP, field)) {
        return false
      }
      if (entry === undefined) {
        return true
      }
      const ownership =
        WORKSPACE_SESSION_FIELD_OWNERSHIP[field as keyof typeof WORKSPACE_SESSION_FIELD_OWNERSHIP]
      if (field === 'activeConnectionIdsAtShutdown') {
        return (
          Array.isArray(entry) &&
          entry.every((id) => typeof id === 'string' && id !== scope.targetId)
        )
      }
      if (field === 'activeWorktreeIdsOnShutdown') {
        return Array.isArray(entry) && entry.every((id) => typeof id === 'string' && !owns(id))
      }
      // Global selection retains migrated IDs; only the recorded destination owns this exception.
      if (
        value.activeWorkspaceExecutionHostId ===
          toRuntimeExecutionHostId(record.release.cutover.destinationEnvironmentId) &&
        typeof entry === 'string' &&
        !isWorktreeHostIdentity(entry) &&
        ((field === 'activeRepoId' && scope.repoIds.has(entry)) ||
          ((field === 'activeWorktreeId' || field === 'activeWorkspaceKey') && owns(entry)))
      ) {
        return true
      }
      if (field === 'activeRepoId' && typeof entry === 'string' && scope.repoIds.has(entry)) {
        return false
      }
      if (field === 'activeWorkspaceExecutionHostId' && entry === scope.hostId) {
        return false
      }
      if (ownership === 'global') {
        if (field === 'browserUrlHistory' || field === 'workspaceDocHistory') {
          return Array.isArray(entry)
        }
        if (field === 'clientHostedBrowserCloseIntentsByEnvironment') {
          return object(entry) && !sourceReference(entry, field)
        }
        return (entry === null || typeof entry === 'string') && !sourceReference(entry, field)
      }
      if (!object(entry)) {
        return false
      }
      return Object.entries(entry).every(([key, row]) => {
        if (!supportedRow(field, row)) {
          return false
        }
        const sourceOwner =
          (ownership === 'worktreeKeyed' || ownership === 'hostPrivate') && owns(key)
        const sourcePane =
          panes.has(key) ||
          ((ownership === 'paneKeyed' ||
            ownership === 'sleepingAgentKeyed' ||
            ownership === 'surfaceTombstoneKeyed') &&
            [...identities].some((id) => key.startsWith(`${id}:`)))
        const referencedTab =
          (field === 'activeTabIdByWorktree' || field === 'terminalPtyIncarnationsByPaneKey') &&
          typeof row === 'string' &&
          identities.has(row)
        return (
          !sourceOwner &&
          !sourcePane &&
          !referencedTab &&
          !identities.has(key) &&
          !sourceReference(row, field)
        )
      })
    })
  }
  // Both spill surfaces stay fenced even when one did not change during installation.
  if (
    !safeSession(state.workspaceSession) ||
    !safeSession(state.workspaceSessionsByHostId?.[scope.hostId])
  ) {
    return false
  }
  for (const { before, after, current } of pairs) {
    if (!safeSession(current)) {
      return false
    }
    for (const field of new Set([
      ...Object.keys((before ?? {}) as JsonRecord),
      ...Object.keys((after ?? {}) as JsonRecord)
    ])) {
      const original = (before as JsonRecord | undefined)?.[field]
      const expected = (after as JsonRecord | undefined)?.[field]
      const observed = (current as JsonRecord | undefined)?.[field]
      if (same(original, expected)) {
        continue
      }
      if (object(original) && object(expected)) {
        for (const key of new Set([...Object.keys(original), ...Object.keys(expected)])) {
          if (
            !same(original[key], expected[key]) &&
            !same((observed as JsonRecord | undefined)?.[key], expected[key])
          ) {
            return false
          }
        }
      } else if (object(original) && expected === undefined) {
        if (
          observed !== undefined &&
          (!object(observed) || Object.keys(original).some((key) => Object.hasOwn(observed, key)))
        ) {
          return false
        }
      } else if (
        field !== 'activeConnectionIdsAtShutdown' &&
        field !== 'activeWorktreeIdsOnShutdown' &&
        typeof original !== 'string' &&
        original !== null &&
        !same(observed, expected)
      ) {
        return false
      }
    }
  }
  return true
}
