import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import {
  MaestroWorkspaceCanvasAuthority,
  type MaestroWorkspaceCanvasRuntime
} from './maestro-workspace-canvas-authority'

const scope = { execution_host_id: 'local', workspace_key: 'folder:folder-1' }

function emptySession(): RuntimeMobileSessionTabsResult {
  return {
    worktree: 'folder-1',
    publicationEpoch: 'renderer-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: null,
    activeTabType: null,
    tabGroups: [{ id: 'group-1', activeTabId: null, tabOrder: [] }],
    tabs: []
  }
}

describe('Maestro workspace empty terminal creation', () => {
  it('creates an exact selected-agent terminal from an empty workspace session', async () => {
    const database = new OrchestrationDb(':memory:')
    let created = false
    let pollsAfterCreate = 0
    const createdTab = {
      type: 'terminal' as const,
      id: 'terminal-created::leaf-created',
      parentTabId: 'terminal-created',
      leafId: 'leaf-created',
      ptyId: 'pty-created',
      status: 'ready' as const,
      terminal: 'terminal-handle-created',
      title: 'Terminal 1',
      isActive: false
    }
    const projectedSession = {
      ...emptySession(),
      publicationEpoch: 'renderer-2',
      snapshotVersion: 2,
      activeTabId: null,
      activeTabType: null,
      tabGroups: [
        {
          id: 'group-1',
          activeTabId: null,
          tabOrder: [createdTab.parentTabId]
        }
      ],
      tabs: [createdTab]
    }
    const listMobileSessionTabs = vi.fn().mockImplementation(async () => {
      if (!created || pollsAfterCreate++ === 0) {
        return emptySession()
      }
      return projectedSession
    })
    const createMobileSessionTerminal = vi.fn().mockImplementation(async () => {
      created = true
      return { tab: createdTab, publicationEpoch: 'renderer-2', snapshotVersion: 2 }
    })
    const runtime = {
      listMobileSessionTabs,
      listTerminals: vi.fn().mockResolvedValue({ terminals: [], totalCount: 0, truncated: false }),
      activateMobileSessionTab: vi.fn(),
      closeMobileSessionTab: vi.fn(),
      createMobileSessionTerminal,
      browserTabCreate: vi.fn(),
      createMaestroWorkspaceAnnotation: vi.fn(),
      commandMaestroWorkspaceTab: vi.fn(),
      readMobileMarkdownTab: vi.fn(),
      saveMobileMarkdownTab: vi.fn(),
      readMobileFile: vi.fn(),
      getTerminalProcessIncarnation: vi.fn().mockReturnValue('pty-created:incarnation-1'),
      getOrchestrationDb: () => database
    } satisfies MaestroWorkspaceCanvasRuntime
    const authority = new MaestroWorkspaceCanvasAuthority(runtime, {
      projectionAttempts: 3,
      projectionIntervalMs: 0
    })
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing empty workspace snapshot')
    }

    const placement = {
      position: { x: 120, y: 84 },
      size: { width: 760, height: 530 },
      collapsed: false,
      z_order: 2
    }
    const result = await authority.mutate({
      action: 'create',
      surface_type: 'terminal',
      agent: 'opencode',
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      expected_canvas_revision: current.canvas.revision,
      placement,
      idempotency_key: 'terminal-create-empty-1'
    })

    expect(result).toMatchObject({
      status: 'applied',
      surface_id: { ...scope, unified_tab_id: createdTab.parentTabId }
    })
    expect(createMobileSessionTerminal).toHaveBeenCalledWith('id:folder:folder-1', {
      clientMutationId: 'terminal-create-empty-1',
      agent: 'opencode',
      activate: false,
      select: false,
      runtimeOwned: true
    })
    const projected = await authority.query(scope, 'actor-1')
    if (projected.status !== 'available') {
      throw new Error('missing created terminal snapshot')
    }
    expect(Object.values(projected.snapshot.surfaces)).toMatchObject([
      {
        id: { ...scope, unified_tab_id: createdTab.parentTabId },
        binding: { kind: 'terminal', terminal_tab_id: createdTab.parentTabId }
      }
    ])
    expect(
      projected.canvas.document.placements[
        workspaceSurfaceKey({ ...scope, unified_tab_id: createdTab.parentTabId })
      ]
    ).toEqual(placement)
    database.close()
  })

  it('refuses to report applied before the exact terminal surface is projected', async () => {
    const database = new OrchestrationDb(':memory:')
    const createdTab = {
      type: 'terminal' as const,
      id: 'terminal-delayed::leaf-delayed',
      parentTabId: 'terminal-delayed',
      leafId: 'leaf-delayed',
      ptyId: 'pty-delayed',
      status: 'ready' as const,
      terminal: 'terminal-handle-delayed',
      title: 'Terminal delayed',
      isActive: false
    }
    const runtime = {
      listMobileSessionTabs: vi.fn().mockResolvedValue(emptySession()),
      listTerminals: vi.fn().mockResolvedValue({ terminals: [], totalCount: 0, truncated: false }),
      activateMobileSessionTab: vi.fn(),
      closeMobileSessionTab: vi.fn(),
      createMobileSessionTerminal: vi.fn().mockResolvedValue({
        tab: createdTab,
        publicationEpoch: 'renderer-2',
        snapshotVersion: 2
      }),
      browserTabCreate: vi.fn(),
      createMaestroWorkspaceAnnotation: vi.fn(),
      commandMaestroWorkspaceTab: vi.fn(),
      readMobileMarkdownTab: vi.fn(),
      saveMobileMarkdownTab: vi.fn(),
      readMobileFile: vi.fn(),
      getTerminalProcessIncarnation: vi.fn().mockReturnValue('pty-delayed:incarnation-1'),
      getOrchestrationDb: () => database
    } satisfies MaestroWorkspaceCanvasRuntime
    const authority = new MaestroWorkspaceCanvasAuthority(runtime, {
      projectionAttempts: 3,
      projectionIntervalMs: 0
    })
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing empty workspace snapshot')
    }

    const result = await authority.mutate({
      action: 'create',
      surface_type: 'terminal',
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      idempotency_key: 'terminal-create-delayed-1'
    })

    expect(result).toMatchObject({
      status: 'outcome_unknown',
      surface_id: { ...scope, unified_tab_id: createdTab.parentTabId },
      reason: 'created_surface_not_projected'
    })
    database.close()
  })
})
