import type Database from '../sqlite/sync-database'
import type { SurfaceKey, WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import { workspaceSurfaceSchema } from '../../shared/workspace-surfaces/surface-schema'
import { reconcileSurfaceAllocations } from './surface-allocation-rows'
import { releaseSurfaceIdentities, writeSurfaceLeafIdentities } from './surface-identities'
import { recordSurfaceHost, recordSurfaceWrite } from './surface-transaction-changes'

export function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    throw new Error('surface_row_unreadable')
  }
  return JSON.parse(value)
}

export function rowKey(surface: Pick<SurfaceKey, 'workspaceId' | 'hostTabId'>): string {
  return JSON.stringify([surface.workspaceId, surface.hostTabId])
}

export function parseSurface(value: unknown): WorkspaceSurface {
  return workspaceSurfaceSchema.parse(parseJson(value))
}

export function readSurface(db: Database.Database, key: SurfaceKey): WorkspaceSurface | null {
  const row = db
    .prepare(`SELECT row_json FROM main.workspace_surfaces
    WHERE host_id = ? AND workspace_id = ? AND host_tab_id = ?`)
    .get(key.hostId, key.workspaceId, key.hostTabId)
  return row ? parseSurface(row.row_json) : null
}

export function readWorkspace(
  db: Database.Database,
  hostId: string,
  workspaceId: string
): WorkspaceSurface[] {
  return db
    .prepare(`SELECT row_json FROM main.workspace_surfaces
    WHERE host_id = ? AND workspace_id = ? ORDER BY rowid`)
    .all(hostId, workspaceId)
    .map((row) => parseSurface(row.row_json))
}

export function domainRevision(db: Database.Database, hostId: string): number {
  return Number(
    db.prepare('SELECT revision FROM main.workspace_surface_domains WHERE host_id = ?').get(hostId)
      ?.revision ?? 0
  )
}

export function advanceDomain(db: Database.Database, hostId: string): number {
  db.prepare(
    'UPDATE main.workspace_surface_domains SET revision = revision + 1 WHERE host_id = ?'
  ).run(hostId)
  const revision = domainRevision(db, hostId)
  recordSurfaceHost(db, hostId, true, revision)
  return revision
}

export function writeSurface(db: Database.Database, input: WorkspaceSurface): void {
  const surface = workspaceSurfaceSchema.parse(input)
  const sessionId = surface.content?.kind === 'agent-session' ? surface.content.sessionId : null
  db.prepare(`INSERT INTO main.workspace_surfaces(host_id, workspace_id, host_tab_id, row_json, session_id)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(host_id, workspace_id, host_tab_id)
    DO UPDATE SET row_json = excluded.row_json, session_id = excluded.session_id`).run(
    surface.hostId,
    surface.workspaceId,
    surface.hostTabId,
    JSON.stringify(surface),
    sessionId
  )
  writeSurfaceLeafIdentities(db, surface)
  recordSurfaceWrite(db, surface)
}

export function writeChanges(db: Database.Database, changes: readonly WorkspaceSurface[]): void {
  const previous = changes.flatMap((surface) => {
    const current = readSurface(db, surface)
    return current ? [current] : []
  })
  reconcileSurfaceAllocations(db, previous, changes)
  // Release unique conversation claims before moving one to its new surface.
  for (const surface of previous) {
    releaseSurfaceIdentities(db, surface)
    if (surface.content?.kind === 'agent-session') {
      db.prepare(
        'UPDATE main.workspace_surfaces SET session_id = NULL WHERE host_id = ? AND workspace_id = ? AND host_tab_id = ?'
      ).run(surface.hostId, surface.workspaceId, surface.hostTabId)
    }
  }
  for (const surface of changes) {
    writeSurface(db, surface)
  }
}

/** Moving the single native view never closes or removes the conversation itself. */
export function withRetiredChatViews(
  db: Database.Database,
  changes: readonly WorkspaceSurface[],
  mintId: () => string
): WorkspaceSurface[] {
  const changed = new Map(changes.map((surface) => [rowKey(surface), surface]))
  for (const surface of changes) {
    if (surface.content?.kind !== 'agent-session') {
      continue
    }
    const row = db
      .prepare('SELECT row_json FROM main.workspace_surfaces WHERE host_id = ? AND session_id = ?')
      .get(surface.hostId, surface.content.sessionId)
    const holder = row ? parseSurface(row.row_json) : null
    if (holder && !changed.has(rowKey(holder))) {
      changed.set(rowKey(holder), {
        ...holder,
        content: null,
        occurrence: mintId(),
        revision: holder.revision + 1
      })
    }
  }
  return [...changed.values()]
}

export function rebuildLegacyChatTabs(
  db: Database.Database,
  schema: 'main' | 'surface_chat',
  hostId: string
): void {
  db.prepare(`DELETE FROM ${schema}.agent_session_tabs`).run()
  const insert = db.prepare(
    `INSERT INTO ${schema}.agent_session_tabs(tab_id, session_id, position) VALUES (?, ?, ?)`
  )
  for (const [position, row] of db
    .prepare(
      'SELECT row_json FROM main.workspace_surfaces WHERE host_id = ? AND session_id IS NOT NULL ORDER BY rowid'
    )
    .all(hostId)
    .entries()) {
    const surface = parseSurface(row.row_json)
    if (surface.content?.kind === 'agent-session') {
      insert.run(surface.hostTabId, surface.content.sessionId, position)
    }
  }
  db.prepare(
    `INSERT OR REPLACE INTO ${schema}.agent_session_store_meta(key, value) VALUES (?, ?)`
  ).run('session_tabs_recorded', '1')
}
