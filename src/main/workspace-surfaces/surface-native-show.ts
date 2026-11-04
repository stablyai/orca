import { parseSurface } from './surface-rows'
import type Database from '../sqlite/sync-database'
import type { WorkspaceSurfaceRepository } from './surface-repository'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { SurfaceStorageCommand } from '../../shared/workspace-surfaces/surface-storage-command'
import type { SurfaceCommandOutcome } from '../../shared/workspace-surfaces/surface-command'
import { readSurfaceChatRecord } from './surface-native-membership'

/** A show names one conversation and compares its captured source; unrelated membership is never replaced. */
export function showNativeSurface(
  db: Database.Database,
  repository: WorkspaceSurfaceRepository,
  session: WorkspaceSessionState,
  command: Extract<SurfaceStorageCommand, { type: 'show-native' }>
): SurfaceCommandOutcome {
  const row = db
    .prepare('SELECT row_json FROM main.workspace_surfaces WHERE host_id = ? AND session_id = ?')
    .get(command.hostId, command.sessionId)
  const current = row ? parseSurface(row.row_json) : undefined
  const expected = command.expected
  if (
    expected
      ? !current ||
        current.workspaceId !== expected.workspaceId ||
        current.hostTabId !== expected.hostTabId ||
        current.occurrence !== expected.occurrence ||
        current.revision !== expected.revision
      : current !== undefined
  ) {
    return { status: 'conflict', code: 'surface_changed', current: current ?? null }
  }
  const record = readSurfaceChatRecord(db, command.sessionId)
  if (record.location.executionHostId !== command.hostId) {
    throw new Error('Native surface belongs to another host')
  }
  const held = db
    .prepare(
      "SELECT row_json FROM main.workspace_surfaces WHERE host_id = ? AND host_tab_id = ? AND json_extract(row_json, '$.content') IS NOT NULL"
    )
    .get(command.hostId, command.hostTabId)
  const target = held
    ? parseSurface(held.row_json)
    : repository.read({
        hostId: command.hostId,
        workspaceId: record.location.workspaceId,
        hostTabId: command.hostTabId
      })
  const otherKind = Object.values(session.unifiedTabs ?? {}).some((tabs) =>
    tabs.some(
      (tab) =>
        tab.id === command.hostTabId &&
        tab.contentType !== 'terminal' &&
        tab.contentType !== 'agent-session'
    )
  )
  if (
    otherKind ||
    (target?.content &&
      (target.occurrence !== current?.occurrence || target.workspaceId !== current?.workspaceId))
  ) {
    return { status: 'conflict', code: 'tab_exists', current: target ?? null }
  }
  return repository.replaceContent({
    ...command.identity,
    hostId: command.hostId,
    workspaceId: record.location.workspaceId,
    hostTabId: command.hostTabId,
    expected: target ? { occurrence: target.occurrence, revision: target.revision } : null,
    content: { kind: 'agent-session', sessionId: command.sessionId, agent: record.provider }
  })
}
