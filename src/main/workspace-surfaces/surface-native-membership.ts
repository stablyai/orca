import type { SurfaceStorageMutation } from '../../shared/workspace-surfaces/surface-storage-command'
import { structuredAgentSessionTabId } from '../../shared/agent-session/view/structured-agent-session-projection'
import { randomUUID } from 'node:crypto'
import type Database from '../sqlite/sync-database'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import {
  surfaceChatProjectionSchema,
  type SurfaceChatProjection,
  type SurfaceHostDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import { isPersistedAgentSessionRecord } from '../../shared/agent-session/lifecycle/agent-session-record'
import {
  reserveImportedSurfaceIdentities,
  retainSurfaceReference
} from './surface-migration-identities'
import {
  advanceDomain,
  parseJson,
  rowKey,
  withRetiredChatViews,
  writeChanges
} from './surface-rows'
import type { WorkspaceSurfaceRepository } from './surface-repository'

const marker = (hostId: string): string => `workspace_surface_projection:${hostId}`

export function readSurfaceChatRecord(db: Database.Database, sessionId: string) {
  const row = db
    .prepare('SELECT record_json FROM surface_chat.agent_session_records WHERE session_id = ?')
    .get(sessionId)
  const record = decodeSurfaceChatRecord(row?.record_json, sessionId)
  if (!record) {
    throw new Error('Native surface requires a readable durable conversation')
  }
  return record
}

function decodeSurfaceChatRecord(json: unknown, sessionId: string) {
  let record: unknown
  try {
    record = parseJson(json)
  } catch {
    return null
  }
  return isPersistedAgentSessionRecord(record) && record.sessionId === sessionId ? record : null
}

/** Read actual old-build edits even when the attributed profile revision never changed. */
export function reconcileSurfaceNativeMembership(
  db: Database.Database,
  repository: WorkspaceSurfaceRepository,
  hostId: ExecutionHostId,
  host: SurfaceHostDomain,
  session: WorkspaceSessionState,
  mintId: () => string = randomUUID,
  commands: readonly SurfaceStorageMutation[] = []
): { tabId: string; sessionId: string }[] {
  const unresolved: { tabId: string; sessionId: string }[] = []
  const attributed = db
    .prepare('SELECT value FROM surface_chat.agent_session_store_meta WHERE key = ?')
    .get(marker(hostId))
  const baseline = attributed
    ? surfaceChatProjectionSchema.parse(parseJson(attributed.value))
    : host.chatBaseline
  const recorded =
    db
      .prepare('SELECT 1 FROM surface_chat.agent_session_store_meta WHERE key = ?')
      .get('session_tabs_recorded') !== undefined
  const seenSessions = new Set<string>()
  const actual = db
    .prepare('SELECT tab_id, session_id FROM surface_chat.agent_session_tabs ORDER BY position')
    .all()
    .map((row) => {
      if (
        typeof row.tab_id !== 'string' ||
        !row.tab_id ||
        typeof row.session_id !== 'string' ||
        !row.session_id
      ) {
        throw new Error('Native surface membership is unreadable')
      }
      return { tabId: row.tab_id, sessionId: row.session_id }
    })
    .filter((row) => {
      if (seenSessions.has(row.sessionId)) {
        return false
      }
      seenSessions.add(row.sessionId)
      return true
    })
  if (!recorded) {
    const sessions = new Set(actual.map((row) => row.sessionId))
    for (const tabs of Object.values(session.unifiedTabs ?? {})) {
      for (const tab of tabs) {
        if (tab.contentType === 'agent-session' && !sessions.has(tab.entityId)) {
          actual.push({ tabId: tab.id, sessionId: tab.entityId })
          sessions.add(tab.entityId)
        }
      }
    }
    if (hostId === 'local' && host.chatInitialization !== 'verified') {
      const initial = commands.find(
        (command) => command.hostId === hostId && command.type === 'initialize'
      )
      const captured = initial?.type === 'initialize' ? (initial.legacySessionTabIds ?? []) : []
      for (const sessionId of captured) {
        if (sessions.has(sessionId)) {
          continue
        }
        const row = db
          .prepare(
            'SELECT record_json FROM surface_chat.agent_session_records WHERE session_id = ?'
          )
          .get(sessionId)
        const record = decodeSurfaceChatRecord(row?.record_json, sessionId)
        if (record?.location.executionHostId !== hostId) {
          continue
        }
        actual.push({ tabId: structuredAgentSessionTabId(sessionId), sessionId })
        sessions.add(sessionId)
      }
    }
  }
  const previous = repository.all(hostId)
  const previousByKey = new Map(previous.map((surface) => [rowKey(surface), surface]))
  const previousByTab = new Map(previous.map((surface) => [surface.hostTabId, surface]))
  const actualTabs = new Set(actual.map((row) => JSON.stringify([row.tabId, row.sessionId])))
  const baselineTabs = new Set(
    baseline?.tabs.map((row) => JSON.stringify([row.tabId, row.sessionId]))
  )
  const retired = (baseline?.surfaces ?? []).flatMap((before) => {
    const content = before.content
    if (
      content?.kind !== 'agent-session' ||
      actualTabs.has(JSON.stringify([before.hostTabId, content.sessionId]))
    ) {
      return []
    }
    const current = previousByKey.get(rowKey(before))
    return current?.content?.kind === 'agent-session' && current.occurrence === before.occurrence
      ? [{ ...current, content: null, occurrence: mintId(), revision: current.revision + 1 }]
      : []
  })
  if (retired.length) {
    writeChanges(db, retired)
  }
  const heldByKey = new Map(previousByKey)
  for (const surface of retired) {
    heldByKey.set(rowKey(surface), surface)
  }
  const held = [...heldByKey.values()]
  const bySession = new Map(
    held.flatMap((surface) =>
      surface.content?.kind === 'agent-session'
        ? [[surface.content.sessionId, surface] as const]
        : []
    )
  )
  const workspacesByTab = new Map(
    Object.entries(session.unifiedTabs ?? {}).flatMap(([workspace, tabs]) =>
      tabs.map((tab) => [tab.id, workspace] as const)
    )
  )
  const incoming: WorkspaceSurface[] = []
  const replaced = new Set<WorkspaceSurface>()
  for (const row of actual) {
    const saved = db
      .prepare('SELECT record_json FROM surface_chat.agent_session_records WHERE session_id = ?')
      .get(row.sessionId)
    const record = decodeSurfaceChatRecord(saved?.record_json, row.sessionId)
    if (!record || record.location.executionHostId !== hostId) {
      unresolved.push(row)
      const workspaceId =
        previousByTab.get(row.tabId)?.workspaceId ??
        workspacesByTab.get(row.tabId) ??
        'unresolved-native-reference'
      retainSurfaceReference(host, {
        workspaceId,
        kind: 'agent-session',
        id: row.tabId,
        raw: {
          tabId: row.tabId,
          sessionId: row.sessionId,
          recordJson: typeof saved?.record_json === 'string' ? saved.record_json : null
        }
      })
      continue
    }
    const current = bySession.get(row.sessionId)
    const was = baselineTabs.has(JSON.stringify([row.tabId, row.sessionId]))
    if (current && (was || current.hostTabId === row.tabId)) {
      continue
    }
    incoming.push({
      hostId,
      workspaceId: record.location.workspaceId,
      hostTabId: row.tabId,
      occurrence: mintId(),
      revision: 1,
      createdAt: record.createdAt,
      content: { kind: 'agent-session', sessionId: row.sessionId, agent: record.provider }
    })
    if (current) {
      replaced.add(current)
    }
  }
  if (incoming.length) {
    const reserved = Object.values(session.unifiedTabs ?? {}).flatMap((tabs) =>
      tabs
        .filter((tab) => tab.contentType !== 'terminal' && tab.contentType !== 'agent-session')
        .map((tab) => tab.id)
    )
    const imported = reserveImportedSurfaceIdentities(
      incoming,
      held.filter((surface) => !replaced.has(surface)),
      reserved,
      host,
      mintId
    )
    writeChanges(db, withRetiredChatViews(db, imported, mintId))
  }
  if (retired.length || actual.length > 0 || host.chatInitialization !== 'verified') {
    advanceDomain(db, hostId)
  }
  host.chatInitialization = 'verified'
  return unresolved
}

/** One legacy index represents all participating hosts in the common commit. */
export function writeSurfaceNativeMemberships(
  db: Database.Database,
  hosts: readonly (readonly [ExecutionHostId, SurfaceHostDomain])[],
  mintId: () => string,
  unresolvedByHost: ReadonlyMap<string, readonly { tabId: string; sessionId: string }[]>
): void {
  const key = (row: { tabId: string; sessionId: string }) =>
    JSON.stringify([row.tabId, row.sessionId])
  const unresolved = [...unresolvedByHost.values()]
  const unknownByHost = new Map(
    [...unresolvedByHost].map(([hostId, rows]) => [hostId, new Set(rows.map(key))])
  )
  const unknown = [...unknownByHost.values()]
  const retained = (unresolved[0] ?? []).filter((row) => unknown.every((set) => set.has(key(row))))
  const tabs = hosts.flatMap(([hostId, host]) =>
    host.surfaces.flatMap((surface) => {
      if (surface.content?.kind !== 'agent-session') {
        return []
      }
      const tab = { tabId: surface.hostTabId, sessionId: surface.content.sessionId }
      if (unknownByHost.get(hostId)?.has(key(tab))) {
        return [tab]
      }
      const record = readSurfaceChatRecord(db, surface.content.sessionId)
      if (
        record.location.executionHostId !== hostId ||
        record.location.workspaceId !== surface.workspaceId ||
        record.provider !== surface.content.agent
      ) {
        throw new Error('Native surface conversation identity changed')
      }
      return [tab]
    })
  )
  const known = new Set(tabs.map((row) => row.sessionId))
  const desired = new Map(
    tabs.concat(retained.filter((row) => !known.has(row.sessionId))).map((row) => [key(row), row])
  )
  const ordered = db
    .prepare('SELECT tab_id, session_id FROM surface_chat.agent_session_tabs ORDER BY position')
    .all()
    .flatMap((row) => {
      const id = JSON.stringify([row.tab_id, row.session_id])
      const tab = desired.get(id)
      desired.delete(id)
      return tab ? [tab] : []
    })
    .concat([...desired.values()])
  db.prepare('DELETE FROM surface_chat.agent_session_tabs').run()
  const insert = db.prepare(
    'INSERT INTO surface_chat.agent_session_tabs(tab_id, session_id, position) VALUES (?, ?, ?)'
  )
  for (const [position, row] of ordered.entries()) {
    insert.run(row.tabId, row.sessionId, position)
  }
  db.prepare(
    'INSERT OR REPLACE INTO surface_chat.agent_session_store_meta(key, value) VALUES (?, ?)'
  ).run('session_tabs_recorded', '1')
  const attribute = db.prepare(
    'INSERT OR REPLACE INTO surface_chat.agent_session_store_meta(key, value) VALUES (?, ?)'
  )
  for (const [hostId, host] of hosts) {
    const baseline: SurfaceChatProjection = {
      commitId: mintId(),
      revision: host.revision,
      recorded: true,
      surfaces: host.surfaces.filter((row) => row.content?.kind === 'agent-session'),
      tabs: ordered
    }
    attribute.run(marker(hostId), JSON.stringify(baseline))
    host.chatBaseline = baseline
  }
}
