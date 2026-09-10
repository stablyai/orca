import { describe, expect, it, vi } from 'vitest'
import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import { writeWorkspaceCanvasDocument } from '../../orchestration/db/maestro-workspace-canvas/maestro-workspace-canvas-store'
import { mutateExistingMaestroWorkspaceSurface } from './maestro-workspace-existing-surface-mutation'

vi.mock('../../orchestration/db/maestro-workspace-canvas/maestro-workspace-canvas-store', () => ({
  writeWorkspaceCanvasDocument: vi.fn(() => ({ revision: 8 }))
}))

describe('existing Maestro workspace surface mutations', () => {
  it('updates the exact annotation draft and persists its visual tone', async () => {
    const scope = { execution_host_id: 'local', workspace_key: 'workspace-1' }
    const surfaceId = { ...scope, unified_tab_id: 'annotation-tab-1' }
    const surfaceKey = workspaceSurfaceKey(surfaceId)
    const readMobileMarkdownTab = vi.fn().mockResolvedValue({
      tabId: surfaceId.unified_tab_id,
      content: '# Note',
      version: 'content:old',
      editable: true
    })
    const saveMobileMarkdownTab = vi.fn().mockResolvedValue({
      tabId: surfaceId.unified_tab_id,
      content: '# Updated note',
      version: 'content:new',
      isDirty: false
    })

    const result = await mutateExistingMaestroWorkspaceSurface({
      runtime: { readMobileMarkdownTab, saveMobileMarkdownTab } as never,
      database: {} as never,
      selector: 'id:workspace-1',
      request: {
        action: 'update-annotation',
        scope,
        actor_id: 'actor-1',
        expected_authority_revision: 4,
        expected_canvas_revision: 7,
        idempotency_key: 'update-annotation-1',
        surface_id: surfaceId,
        content: '# Updated note',
        tone: 'warning'
      },
      before: {
        status: 'available',
        actor_id: 'actor-1',
        snapshot: {
          authority_revision: 4,
          surfaces: {
            [surfaceKey]: {
              id: surfaceId,
              content_type: 'editor',
              entity_id: 'annotation-file-1',
              group_id: 'group-1',
              title: 'Note',
              revision: 4,
              availability: 'available',
              binding: {
                kind: 'content',
                source: { relative_path: '.orca/maestro/note.md', mode: 'edit' },
                annotation: { relative_path: '.orca/maestro/note.md', tone: 'observation' },
                model_revision: 'content:old'
              }
            }
          }
        },
        canvas: {
          revision: 7,
          document: {
            annotations: {
              [surfaceKey]: {
                surface_key: surfaceKey,
                relative_path: '.orca/maestro/note.md',
                tone: 'observation',
                created_by: 'actor-1',
                created_at: '2026-08-26T00:00:00.000Z'
              }
            }
          }
        }
      } as never
    })

    expect(readMobileMarkdownTab).toHaveBeenCalledWith('id:workspace-1', 'annotation-tab-1')
    expect(saveMobileMarkdownTab).toHaveBeenCalledWith(
      'id:workspace-1',
      'annotation-tab-1',
      'content:old',
      '# Updated note'
    )
    expect(writeWorkspaceCanvasDocument).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        document: expect.objectContaining({
          annotations: expect.objectContaining({
            [surfaceKey]: expect.objectContaining({ tone: 'warning' })
          })
        })
      })
    )
    expect(result).toMatchObject({ surfaceId, canvasRevision: 8 })
  })

  it('focuses the exact existing Browser tab through its acknowledged owner', async () => {
    const scope = { execution_host_id: 'local', workspace_key: 'workspace-1' }
    const surfaceId = { ...scope, unified_tab_id: 'browser-unified-1' }
    const surfaceKey = workspaceSurfaceKey(surfaceId)
    const commandMaestroWorkspaceTab = vi.fn().mockResolvedValue({
      tabId: surfaceId.unified_tab_id
    })
    const activateMobileSessionTab = vi.fn()

    await mutateExistingMaestroWorkspaceSurface({
      runtime: { commandMaestroWorkspaceTab, activateMobileSessionTab } as never,
      database: {} as never,
      selector: 'id:workspace-1',
      request: {
        action: 'focus',
        scope,
        actor_id: 'actor-1',
        expected_authority_revision: 4,
        expected_canvas_revision: 7,
        idempotency_key: 'focus-browser-1',
        surface_id: surfaceId
      },
      before: {
        status: 'available',
        actor_id: 'actor-1',
        snapshot: {
          authority_revision: 4,
          surfaces: {
            [surfaceKey]: {
              id: surfaceId,
              content_type: 'browser',
              entity_id: 'browser-workspace-1',
              group_id: 'group-1',
              title: 'Browser',
              revision: 4,
              availability: 'available',
              binding: {
                kind: 'browser',
                browser_workspace_id: 'browser-workspace-1',
                browser_page_id: 'browser-page-1',
                profile_id: null,
                partition_id: null,
                authority_revision: 4,
                live_frame: null,
                immutable_capture: null
              }
            }
          }
        },
        canvas: {
          revision: 7,
          document: {
            placements: {
              [surfaceKey]: {
                position: { x: 10, y: 20 },
                size: { width: 320, height: 220 },
                z_order: 1
              }
            }
          }
        }
      } as never
    })

    expect(commandMaestroWorkspaceTab).toHaveBeenCalledWith({
      kind: 'focus',
      worktreeId: 'workspace-1',
      tabId: 'browser-unified-1'
    })
    expect(activateMobileSessionTab).not.toHaveBeenCalled()
  })
})
