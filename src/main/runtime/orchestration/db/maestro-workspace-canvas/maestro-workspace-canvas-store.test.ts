import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptyWorkspaceCanvasDocument } from '../../../../../shared/maestro-workspace-document-state'
import {
  WorkspaceSurfaceSnapshotSchema,
  workspaceSurfaceKey
} from '../../../../../shared/maestro-workspace-canvas'
import { OrchestrationDb } from '../orchestration-db'
import {
  migrateMaestroWorkspaceCanvasStore,
  readWorkspaceCanvasDocument,
  reconcileStoredWorkspaceCanvas,
  writeWorkspaceCanvasDocument
} from './maestro-workspace-canvas-store'

const scope = { execution_host_id: 'local', workspace_key: 'folder:workspace-1' }
const surfaceId = { ...scope, unified_tab_id: 'tab-1' }
const surfaceKey = workspaceSurfaceKey(surfaceId)

function snapshot(authorityRevision: number, state: 'ready' | 'unavailable' = 'ready') {
  return WorkspaceSurfaceSnapshotSchema.parse({
    schema_version: 1,
    protocol: 'workspace-surface-snapshot/v1',
    ...scope,
    authority_revision: authorityRevision,
    authority_cursor: `cursor-${authorityRevision}`,
    state,
    surfaces:
      state === 'ready'
        ? {
            [surfaceKey]: {
              id: surfaceId,
              content_type: 'browser',
              entity_id: 'browser-workspace-1',
              group_id: 'group-1',
              title: 'Documentation',
              revision: authorityRevision,
              availability: 'available',
              binding: {
                kind: 'browser',
                browser_workspace_id: 'browser-workspace-1',
                browser_page_id: 'page-1',
                profile_id: null,
                partition_id: null,
                authority_revision: authorityRevision,
                live_frame: null,
                immutable_capture: null
              }
            }
          }
        : {},
    unsupported: [],
    automatic_links: [],
    suggested_links: [],
    capability: { available: state === 'ready', reason: state === 'ready' ? null : 'offline' },
    harness_overlay: null
  })
}

describe('workspace Canvas store', () => {
  let database: OrchestrationDb

  beforeEach(() => {
    database = new OrchestrationDb(':memory:')
    migrateMaestroWorkspaceCanvasStore(database)
  })

  afterEach(() => database.close())

  it('persists one workspace-owned document and replays an idempotent write', () => {
    const document = emptyWorkspaceCanvasDocument()
    const first = writeWorkspaceCanvasDocument(database, {
      scope,
      expected_revision: 0,
      idempotency_key: 'write-1',
      document
    })
    const replay = writeWorkspaceCanvasDocument(database, {
      scope,
      expected_revision: 0,
      idempotency_key: 'write-1',
      document
    })
    expect(first).toMatchObject({ outcome: 'applied', revision: 1 })
    expect(replay).toMatchObject({ outcome: 'replayed', revision: 1 })
  })

  it('rejects revision conflicts and idempotency key payload changes', () => {
    const document = emptyWorkspaceCanvasDocument()
    writeWorkspaceCanvasDocument(database, {
      scope,
      expected_revision: 0,
      idempotency_key: 'write-1',
      document
    })
    expect(() =>
      writeWorkspaceCanvasDocument(database, {
        scope,
        expected_revision: 0,
        idempotency_key: 'write-2',
        document
      })
    ).toThrow('revision conflict')
    expect(() =>
      writeWorkspaceCanvasDocument(database, {
        scope,
        expected_revision: 0,
        idempotency_key: 'write-1',
        document: {
          ...document,
          ui_preferences: { ...document.ui_preferences, inspector_open: true }
        }
      })
    ).toThrow('reused with another payload')
  })

  it('reconciles a new Browser at a readable Canvas size', () => {
    reconcileStoredWorkspaceCanvas(database, {
      scope,
      expected_revision: 0,
      idempotency_key: 'reconcile-browser',
      snapshot: snapshot(1)
    })

    const placement = readWorkspaceCanvasDocument(database, scope).document.placements[surfaceKey]
    expect(placement?.size).toEqual({ width: 680, height: 480 })
  })

  it('retains unavailable geometry across restart and ignores older snapshots', () => {
    reconcileStoredWorkspaceCanvas(database, {
      scope,
      expected_revision: 0,
      idempotency_key: 'reconcile-5',
      snapshot: snapshot(5)
    })
    const beforeRestart = readWorkspaceCanvasDocument(database, scope)
    const unavailable = reconcileStoredWorkspaceCanvas(database, {
      scope,
      expected_revision: 1,
      idempotency_key: 'reconcile-6',
      snapshot: snapshot(6, 'unavailable'),
      confirmed_closed_surface_keys: [surfaceKey]
    })
    const stale = reconcileStoredWorkspaceCanvas(database, {
      scope,
      expected_revision: 2,
      idempotency_key: 'reconcile-4',
      snapshot: snapshot(4)
    })
    expect(unavailable).toMatchObject({ outcome: 'applied', last_surface_revision: 6 })
    expect(stale).toMatchObject({ outcome: 'stale_surface_snapshot', revision: 2 })
    expect(readWorkspaceCanvasDocument(database, scope).document.placements[surfaceKey]).toEqual(
      beforeRestart.document.placements[surfaceKey]
    )
  })

  it('cleans geometry and every incident persisted link only after a confirmed close', () => {
    reconcileStoredWorkspaceCanvas(database, {
      scope,
      expected_revision: 0,
      idempotency_key: 'reconcile-1',
      snapshot: snapshot(1)
    })
    const stored = readWorkspaceCanvasDocument(database, scope)
    stored.document.manual_links.push({
      id: 'manual-1',
      source_surface_key: surfaceKey,
      target_surface_key: workspaceSurfaceKey({ ...surfaceId, unified_tab_id: 'tab-2' }),
      link_type: 'context-for',
      label: null,
      author_id: 'user-1',
      created_at: '2026-08-25T12:00:00.000Z',
      revision: 1
    })
    stored.document.suggestion_decisions['accepted-1'] = {
      fingerprint: 'accepted-1',
      suggestion_revision: 1,
      state: 'accepted',
      decided_by: 'user-1',
      decided_at: '2026-08-25T12:00:00.000Z',
      accepted_link: {
        source_surface_key: surfaceKey,
        target_surface_key: workspaceSurfaceKey({ ...surfaceId, unified_tab_id: 'tab-2' }),
        link_type: 'context-for',
        label: null,
        revision: 1
      }
    }
    stored.document.suggestion_decisions['hidden-unrelated'] = {
      fingerprint: 'hidden-unrelated',
      suggestion_revision: 1,
      state: 'hidden',
      decided_by: 'user-1',
      decided_at: '2026-08-25T12:00:00.000Z',
      accepted_link: null
    }
    writeWorkspaceCanvasDocument(database, {
      scope,
      expected_revision: 1,
      idempotency_key: 'manual-link-1',
      document: stored.document
    })
    reconcileStoredWorkspaceCanvas(database, {
      scope,
      expected_revision: 2,
      idempotency_key: 'reconcile-close-2',
      snapshot: snapshot(2),
      confirmed_closed_surface_keys: [surfaceKey]
    })
    const closed = readWorkspaceCanvasDocument(database, scope).document
    expect(closed.placements[surfaceKey]).toBeUndefined()
    expect(closed.manual_links).toHaveLength(0)
    expect(closed.suggestion_decisions['accepted-1']).toBeUndefined()
    expect(closed.suggestion_decisions['hidden-unrelated']).toMatchObject({ state: 'hidden' })
  })
})
