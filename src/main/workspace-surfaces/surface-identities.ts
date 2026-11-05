import type Database from '../sqlite/sync-database'
import type { WorkspaceSurface } from '../../shared/workspace-surfaces/surface-content'
import type { SurfaceCommandOutcome } from '../../shared/workspace-surfaces/surface-command'
import { rowKey, parseSurface } from './surface-row-codec'

/** Check only identities being installed; stale unrelated window contents cannot grant or refuse them. */
export function conflictingSurfaceIdentity(
  db: Database.Database,
  changes: readonly WorkspaceSurface[]
): Extract<SurfaceCommandOutcome, { status: 'conflict' }> | null {
  const changedKeys = new Set(changes.map(rowKey))
  const tabs = new Set<string>()
  const entities = new Set<string>()
  const leaves = new Set<string>()
  const runs = new Set<string>()
  const resources = new Set<string>()
  for (const surface of changes) {
    const content = surface.content
    if (content) {
      const holder = db
        .prepare(`SELECT row_json FROM main.workspace_surfaces
        WHERE host_id = ? AND host_tab_id = ?
        AND json_extract(row_json, '$.content') IS NOT NULL`)
        .get(surface.hostId, surface.hostTabId)
      if (
        tabs.has(surface.hostTabId) ||
        (holder && !changedKeys.has(rowKey(parseSurface(holder.row_json))))
      ) {
        return { status: 'conflict', code: 'tab_exists', current: null }
      }
      tabs.add(surface.hostTabId)
    }
    if (content?.kind !== 'terminal') {
      continue
    }
    const holder = db
      .prepare(`SELECT row_json FROM main.workspace_surfaces WHERE host_id = ?
      AND json_extract(row_json, '$.content.kind') = 'terminal'
      AND json_extract(row_json, '$.content.entityId') = ?`)
      .get(surface.hostId, content.entityId)
    if (
      entities.has(content.entityId) ||
      (holder && !changedKeys.has(rowKey(parseSurface(holder.row_json))))
    ) {
      return { status: 'conflict', code: 'tab_exists', current: null }
    }
    entities.add(content.entityId)
    for (const [leafId, leaf] of Object.entries(content.leaves)) {
      const held = db
        .prepare(`SELECT workspace_id, host_tab_id FROM main.workspace_surface_leaves
        WHERE host_id = ? AND (leaf_id = ? OR run_id = ? OR pty_id = ?)`)
        .all(surface.hostId, leafId, leaf.runId, leaf.facts.ptyId ?? null)
      if (
        leaves.has(leafId) ||
        runs.has(leaf.runId) ||
        (leaf.facts.ptyId !== undefined && resources.has(leaf.facts.ptyId)) ||
        held.some(
          (row) =>
            !changedKeys.has(
              rowKey({
                workspaceId: String(row.workspace_id),
                hostTabId: String(row.host_tab_id)
              })
            )
        )
      ) {
        return { status: 'conflict', code: 'pane_in_other_tab', current: null }
      }
      leaves.add(leafId)
      runs.add(leaf.runId)
      if (leaf.facts.ptyId) {
        resources.add(leaf.facts.ptyId)
      }
    }
  }
  return null
}

export function releaseSurfaceIdentities(db: Database.Database, surface: WorkspaceSurface): void {
  db.prepare(`DELETE FROM main.workspace_surface_leaves
    WHERE host_id = ? AND workspace_id = ? AND host_tab_id = ?`).run(
    surface.hostId,
    surface.workspaceId,
    surface.hostTabId
  )
  // Release the indexed entity before any destination row acquires it.
  db.prepare(`UPDATE main.workspace_surfaces SET row_json = json_set(row_json, '$.content', NULL)
    WHERE host_id = ? AND workspace_id = ? AND host_tab_id = ?`).run(
    surface.hostId,
    surface.workspaceId,
    surface.hostTabId
  )
}

export function writeSurfaceLeafIdentities(db: Database.Database, surface: WorkspaceSurface): void {
  if (surface.content?.kind !== 'terminal') {
    return
  }
  const insert = db.prepare(`INSERT INTO main.workspace_surface_leaves
    (host_id, workspace_id, host_tab_id, leaf_id, run_id, pty_id) VALUES (?, ?, ?, ?, ?, ?)`)
  for (const [leafId, leaf] of Object.entries(surface.content.leaves)) {
    insert.run(
      surface.hostId,
      surface.workspaceId,
      surface.hostTabId,
      leafId,
      leaf.runId,
      leaf.facts.ptyId ?? null
    )
  }
}
