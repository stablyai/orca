import { describe, expect, it } from 'vitest'
import { workspaceSurfaceKey } from '../../../../shared/maestro-workspace-canvas'
import { MaestroWorkspaceCanvasAuthority } from '../../services/maestro-workspace-canvas/maestro-workspace-canvas-authority'
import { MAESTRO_WORKSPACE_CANVAS_METHODS } from './maestro-workspace-canvas'
import {
  attachLinkLease,
  attachParentLinkLease,
  editorSession,
  harness,
  linkedSession,
  parentChildSession,
  publishLinkGraph,
  scope,
  session
} from './maestro-workspace-canvas-test-fixtures'

describe('Maestro workspace Canvas authority', () => {
  it('projects exact terminal and Browser bindings with monotonic revisions', async () => {
    const { authority, database, runtime } = harness()
    const first = await authority.query(scope, 'actor-1')
    expect(first.status).toBe('available')
    if (first.status !== 'available') {
      return
    }
    expect(first.snapshot.authority_revision).toBe(1)
    expect(Object.values(first.snapshot.surfaces)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.objectContaining({ unified_tab_id: 'terminal-tab-1' }),
          binding: expect.objectContaining({
            pane_key: 'leaf-1',
            session_id: 'pty-1',
            pty_incarnation: 'pty-1:incarnation-7'
          })
        }),
        expect.objectContaining({
          id: expect.objectContaining({ unified_tab_id: 'browser-tab-1' }),
          binding: expect.objectContaining({
            browser_workspace_id: 'browser-workspace-1',
            browser_page_id: 'browser-page-1'
          })
        })
      ])
    )
    expect(runtime.getTerminalProcessIncarnation).toHaveBeenCalledWith('terminal-handle-1')
    runtime.listMobileSessionTabs.mockResolvedValue(session(2))
    const second = await authority.query(scope, 'actor-1')
    expect(second.status === 'available' && second.snapshot.authority_revision).toBe(2)
    database.close()
  })

  it('retains last-known resources as unverifiable when host contact is lost', async () => {
    const { authority, database, runtime } = harness()
    await authority.query(scope, 'actor-1')
    runtime.listMobileSessionTabs.mockRejectedValue(new Error('transport_lost'))
    const result = await authority.query(scope, 'actor-1')
    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'authority-unreachable',
      liveness: 'unverifiable'
    })
    if (result.status === 'unavailable') {
      expect(Object.values(result.last_known_snapshot?.surfaces ?? {})).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            availability: 'unverifiable',
            binding: expect.objectContaining({ kind: 'terminal', liveness: 'unverifiable' })
          })
        ])
      )
    }
    database.close()
  })

  it('retains last-known resources as unverifiable when terminal inventory fails', async () => {
    const { authority, database, runtime } = harness()
    await authority.query(scope, 'actor-1')
    runtime.listTerminals.mockRejectedValue(new Error('terminal_inventory_lost'))

    const result = await authority.query(scope, 'actor-1')

    expect(result).toMatchObject({
      status: 'unavailable',
      reason: 'authority-unreachable',
      liveness: 'unverifiable'
    })
    if (result.status === 'unavailable') {
      expect(Object.values(result.last_known_snapshot?.surfaces ?? {})).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            availability: 'unverifiable',
            binding: expect.objectContaining({ kind: 'terminal', liveness: 'unverifiable' })
          })
        ])
      )
    }
    database.close()
  })

  it('focuses only an exact surface and replays its idempotent receipt', async () => {
    const { authority, database, runtime } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    const surface = Object.values(current.snapshot.surfaces).find(
      (candidate) => candidate.binding.kind === 'terminal'
    )
    if (!surface) {
      throw new Error('missing terminal surface')
    }
    const request = {
      action: 'focus' as const,
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      expected_canvas_revision: current.canvas.revision,
      idempotency_key: 'focus-1',
      surface_id: surface.id
    }
    await expect(authority.mutate(request)).resolves.toMatchObject({ status: 'applied' })
    await expect(authority.mutate(request)).resolves.toMatchObject({ status: 'replayed' })
    expect(runtime.activateMobileSessionTab).toHaveBeenCalledTimes(1)
    expect(runtime.activateMobileSessionTab).toHaveBeenCalledWith(
      'id:folder:folder-1',
      'terminal-tab-1',
      'leaf-1'
    )
    const focused = await authority.query(scope, 'actor-1')
    if (focused.status !== 'available') {
      throw new Error('missing focused snapshot')
    }
    expect(
      focused.canvas.document.placements[
        JSON.stringify([scope.execution_host_id, scope.workspace_key, surface.id.unified_tab_id])
      ]?.z_order
    ).toBeGreaterThan(1)
    database.close()
  })

  it('rejects stale Canvas focus separately from a stale surface snapshot', async () => {
    const { authority, database, runtime } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    const surface = Object.values(current.snapshot.surfaces)[0]!
    await expect(
      authority.mutate({
        action: 'focus',
        scope,
        actor_id: 'actor-1',
        expected_authority_revision: current.snapshot.authority_revision,
        expected_canvas_revision: current.canvas.revision - 1,
        idempotency_key: 'focus-stale-canvas',
        surface_id: surface.id
      })
    ).resolves.toMatchObject({ status: 'stale', reason: 'canvas_revision_conflict' })
    const staleSurface = await authority.mutate({
      action: 'focus',
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision - 1,
      expected_canvas_revision: current.canvas.revision,
      idempotency_key: 'focus-stale-surface',
      surface_id: surface.id
    })
    expect(staleSurface).toMatchObject({ status: 'stale' })
    expect(staleSurface.reason).toBeUndefined()
    expect(runtime.activateMobileSessionTab).not.toHaveBeenCalled()
    database.close()
  })

  it('rejects stale Canvas close before deleting authoritative resources', async () => {
    const { authority, database, runtime } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    const surface = Object.values(current.snapshot.surfaces)[0]!
    await expect(
      authority.mutate({
        action: 'close',
        scope,
        actor_id: 'actor-1',
        expected_authority_revision: current.snapshot.authority_revision,
        expected_canvas_revision: current.canvas.revision - 1,
        idempotency_key: 'close-stale-canvas',
        surface_id: surface.id
      })
    ).resolves.toMatchObject({ status: 'stale', reason: 'canvas_revision_conflict' })
    expect(runtime.closeMobileSessionTab).not.toHaveBeenCalled()
    database.close()
  })

  it('persists one drag placement with its elevated z-order across restart', async () => {
    const { authority, database, runtime } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    const surface = Object.values(current.snapshot.surfaces)[0]!
    const request = {
      action: 'set-placement' as const,
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      expected_canvas_revision: current.canvas.revision,
      idempotency_key: 'drag-placement-1',
      surface_id: surface.id,
      placement: {
        position: { x: 360, y: -140 },
        size: { width: 720, height: 480 },
        collapsed: false,
        z_order: 0
      }
    }
    const applied = await authority.mutate(request)
    await expect(authority.mutate(request)).resolves.toMatchObject({ status: 'replayed' })
    expect(applied.status).toBe('applied')

    const restarted = new MaestroWorkspaceCanvasAuthority(runtime)
    const restored = await restarted.query(scope, 'actor-1')
    if (restored.status !== 'available') {
      throw new Error('missing restarted snapshot')
    }
    const placement =
      restored.canvas.document.placements[
        JSON.stringify([scope.execution_host_id, scope.workspace_key, surface.id.unified_tab_id])
      ]
    expect(placement).toMatchObject({
      position: { x: 360, y: -140 },
      size: { width: 720, height: 480 },
      collapsed: false
    })
    expect(placement?.z_order).toBeGreaterThan(1)
    database.close()
  })

  it('restores the exact viewport after leaving and reopening the Canvas', async () => {
    const { authority, database, runtime } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    const request = {
      action: 'set-viewport' as const,
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      expected_canvas_revision: current.canvas.revision,
      idempotency_key: 'viewport-exit-1',
      viewport: { center: { x: 812.5, y: -231.25 }, zoom: 0.75 }
    }
    await expect(authority.mutate(request)).resolves.toMatchObject({ status: 'applied' })
    await expect(authority.mutate(request)).resolves.toMatchObject({ status: 'replayed' })

    const restarted = new MaestroWorkspaceCanvasAuthority(runtime)
    const restored = await restarted.query(scope, 'actor-1')
    if (restored.status !== 'available') {
      throw new Error('missing restarted snapshot')
    }
    expect(restored.canvas.document.viewport).toEqual(request.viewport)
    database.close()
  })

  it('reads clean and dirty editor content from their distinct exact authorities', async () => {
    const { authority, database, runtime } = harness()
    runtime.listMobileSessionTabs.mockResolvedValue(editorSession(false))
    const clean = await authority.query(scope, 'actor-1')
    if (clean.status !== 'available') {
      throw new Error('missing editor snapshot')
    }
    const surface = Object.values(clean.snapshot.surfaces)[0]!
    await expect(authority.readContent(scope, 'actor-1', surface.id)).resolves.toMatchObject({
      tabId: 'editor-tab-1',
      content: 'exact content'
    })
    runtime.listMobileSessionTabs.mockResolvedValue(editorSession(true))
    runtime.commandMaestroWorkspaceTab.mockResolvedValue({
      tabId: 'editor-tab-1',
      content: 'unsaved draft',
      modelRevision: 'content:13:exact'
    })
    const dirty = await authority.query(scope, 'actor-1')
    if (dirty.status !== 'available') {
      throw new Error('missing dirty editor snapshot')
    }
    await expect(authority.readContent(scope, 'actor-1', surface.id)).resolves.toMatchObject({
      content: 'unsaved draft',
      modelRevision: 'content:13:exact'
    })
    expect(runtime.commandMaestroWorkspaceTab).toHaveBeenCalledWith({
      kind: 'read-content',
      worktreeId: 'folder:folder-1',
      tabId: 'editor-tab-1'
    })
    database.close()
  })

  it('creates one deterministic Browser page and replays its durable receipt', async () => {
    const { authority, database, runtime } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    runtime.browserTabCreate.mockImplementation(async ({ page }) => {
      const next = session(2)
      next.tabs = next.tabs.map((tab) =>
        tab.type === 'browser'
          ? {
              ...tab,
              id: 'browser-created',
              browserWorkspaceId: 'browser-created',
              browserPageId: page!
            }
          : tab
      )
      runtime.listMobileSessionTabs.mockResolvedValue(next)
      return { browserPageId: page! }
    })
    const request = {
      action: 'create' as const,
      surface_type: 'browser' as const,
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      expected_canvas_revision: current.canvas.revision,
      placement: {
        position: { x: 612, y: -248 },
        size: { width: 680, height: 480 },
        collapsed: false,
        z_order: 9
      },
      idempotency_key: 'browser-create-1'
    }
    const first = await authority.mutate(request)
    await expect(authority.mutate(request)).resolves.toMatchObject({
      status: 'replayed',
      surface_id: first.surface_id
    })
    expect(runtime.browserTabCreate).toHaveBeenCalledTimes(1)
    expect(runtime.browserTabCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        page: expect.stringMatching(/^maestro-[0-9a-f]{24}$/),
        activate: false,
        focus: false
      })
    )
    const browserResult = await authority.query(scope, 'actor-1')
    if (browserResult.status !== 'available') {
      throw new Error('missing Browser snapshot')
    }
    expect(
      browserResult.canvas.document.placements[
        JSON.stringify([scope.execution_host_id, scope.workspace_key, 'browser-created'])
      ]
    ).toMatchObject({ position: { x: 612, y: -248 } })
    database.close()
  })

  it('creates one real annotation file and exact unified tab across replay', async () => {
    const { authority, database, runtime } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    runtime.commandMaestroWorkspaceTab.mockImplementation(async (command) => {
      if (command.kind !== 'open-annotation') {
        return { tabId: 'annotation-tab-1' }
      }
      runtime.listMobileSessionTabs.mockResolvedValue({
        ...session(2),
        activeTabId: 'annotation-tab-1',
        activeTabType: 'markdown',
        tabGroups: [
          { id: 'group-1', activeTabId: 'annotation-tab-1', tabOrder: ['annotation-tab-1'] }
        ],
        tabs: [
          {
            type: 'markdown',
            id: 'annotation-tab-1',
            title: 'Decision',
            filePath: command.filePath,
            relativePath: command.relativePath,
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: command.filePath,
            sourceFilePath: command.filePath,
            sourceRelativePath: command.relativePath,
            documentVersion: 'model-1'
          }
        ]
      })
      return { tabId: 'annotation-tab-1' }
    })
    const request = {
      action: 'create' as const,
      surface_type: 'content' as const,
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      expected_canvas_revision: current.canvas.revision,
      idempotency_key: 'annotation-create-1',
      title: 'Decision',
      annotation: { text: 'Use the stable API.', tone: 'decision' as const },
      placement: {
        position: { x: -480, y: 316 },
        size: { width: 440, height: 360 },
        collapsed: false,
        z_order: 11
      }
    }
    const first = await authority.mutate(request)
    await expect(authority.mutate(request)).resolves.toMatchObject({
      status: 'replayed',
      surface_id: first.surface_id
    })
    expect(runtime.createMaestroWorkspaceAnnotation).toHaveBeenCalledTimes(1)
    expect(runtime.commandMaestroWorkspaceTab).toHaveBeenCalledTimes(2)
    expect(runtime.commandMaestroWorkspaceTab).toHaveBeenLastCalledWith({
      kind: 'rename',
      worktreeId: 'folder-1',
      tabId: 'annotation-tab-1',
      title: 'Decision'
    })
    const reopened = await authority.query(scope, 'actor-1')
    if (reopened.status !== 'available') {
      throw new Error('missing annotation snapshot')
    }
    expect(Object.values(reopened.snapshot.surfaces)[0]?.binding).toMatchObject({
      kind: 'content',
      annotation: { tone: 'decision' }
    })
    const annotationSurface = Object.values(reopened.snapshot.surfaces)[0]!
    expect(
      reopened.canvas.document.placements[workspaceSurfaceKey(annotationSurface.id)]
    ).toMatchObject({ position: { x: -480, y: 316 } })
    await expect(
      authority.mutate({
        action: 'update-annotation',
        scope,
        actor_id: 'actor-1',
        expected_authority_revision: reopened.snapshot.authority_revision,
        expected_canvas_revision: reopened.canvas.revision,
        idempotency_key: 'annotation-tone-update-1',
        surface_id: annotationSurface.id,
        tone: 'blocked'
      })
    ).resolves.toMatchObject({ status: 'applied' })
    const updated = await authority.query(scope, 'actor-1')
    expect(
      updated.status === 'available'
        ? Object.values(updated.snapshot.surfaces)[0]?.binding
        : undefined
    ).toMatchObject({ kind: 'content', annotation: { tone: 'blocked' } })
    database.close()
  })

  it('renames the exact normal tab once across receipt replay', async () => {
    const { authority, database, runtime } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    const surface = Object.values(current.snapshot.surfaces)[0]!
    runtime.commandMaestroWorkspaceTab.mockResolvedValue({ tabId: surface.id.unified_tab_id })
    const request = {
      action: 'rename' as const,
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      idempotency_key: 'rename-1',
      surface_id: surface.id,
      title: 'Exact title'
    }
    await expect(authority.mutate(request)).resolves.toMatchObject({ status: 'applied' })
    await expect(authority.mutate(request)).resolves.toMatchObject({ status: 'replayed' })
    expect(runtime.commandMaestroWorkspaceTab).toHaveBeenCalledTimes(1)
    expect(runtime.commandMaestroWorkspaceTab).toHaveBeenCalledWith({
      kind: 'rename',
      worktreeId: 'folder:folder-1',
      tabId: surface.id.unified_tab_id,
      title: 'Exact title'
    })
    database.close()
  })

  it('stamps manual-link provenance on the host and rejects invalid endpoints', async () => {
    const { authority, database } = harness()
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing fixture snapshot')
    }
    const keys = Object.keys(current.snapshot.surfaces)
    const applied = await authority.mutate({
      action: 'create-manual-link',
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: current.snapshot.authority_revision,
      expected_canvas_revision: current.canvas.revision,
      idempotency_key: 'manual-link-1',
      source_surface_key: keys[0]!,
      target_surface_key: keys[1]!,
      link_type: 'context-for',
      label: 'Context'
    })
    expect(applied.status).toBe('applied')
    const linked = await authority.query(scope, 'actor-1')
    if (linked.status !== 'available') {
      throw new Error('missing linked snapshot')
    }
    expect(linked.canvas.document.manual_links[0]).toMatchObject({
      author_id: 'actor-1',
      label: 'Context',
      revision: current.canvas.revision + 1
    })
    await expect(
      authority.mutate({
        action: 'create-manual-link',
        scope,
        actor_id: 'actor-1',
        expected_authority_revision: linked.snapshot.authority_revision,
        expected_canvas_revision: linked.canvas.revision,
        idempotency_key: 'manual-link-reversed',
        source_surface_key: keys[1]!,
        target_surface_key: keys[0]!,
        link_type: 'context-for',
        label: null
      })
    ).resolves.toMatchObject({ status: 'applied', canvas_revision: linked.canvas.revision })
    const deduplicated = await authority.query(scope, 'actor-1')
    if (deduplicated.status !== 'available') {
      throw new Error('missing deduplicated snapshot')
    }
    expect(deduplicated.canvas.document.manual_links).toHaveLength(1)
    await expect(
      authority.mutate({
        action: 'create-manual-link',
        scope,
        actor_id: 'actor-1',
        expected_authority_revision: deduplicated.snapshot.authority_revision,
        expected_canvas_revision: deduplicated.canvas.revision,
        idempotency_key: 'manual-link-invalid',
        source_surface_key: keys[0]!,
        target_surface_key: 'missing',
        link_type: 'context-for',
        label: null
      })
    ).resolves.toMatchObject({ status: 'stale', reason: 'invalid_link_endpoints' })
    database.close()
  })

  it('projects an explicit graph edge only after both receipt endpoints resolve exactly', async () => {
    const { authority, database, runtime } = harness()
    runtime.listMobileSessionTabs.mockResolvedValue(linkedSession())
    attachLinkLease(database)
    publishLinkGraph(database)
    const lease = database.getMaestroTerminalLeaseByHandle('terminal-handle-1')
    if (!lease) {
      throw new Error('missing exact terminal lease')
    }
    const expectedObservedAt = lease.updatedAt.includes('T')
      ? lease.updatedAt
      : `${lease.updatedAt.replace(' ', 'T')}Z`

    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing linked snapshot')
    }
    expect(current.snapshot.automatic_links).toEqual([
      expect.objectContaining({
        link_type: 'executes',
        authority_kind: 'execution-receipt',
        authority_id: 'run-1:edge-terminal-executes-browser',
        authority_revision: 7,
        observed_at: expectedObservedAt,
        explanation_code: 'executes-resource'
      })
    ])
    const automatic = current.snapshot.automatic_links[0]!
    expect(current.snapshot.surfaces[automatic.source_surface_key]?.binding.kind).toBe('terminal')
    expect(current.snapshot.surfaces[automatic.target_surface_key]?.binding.kind).toBe('browser')
    expect(current.snapshot.suggested_links).toEqual([])
    database.close()
  })

  it('projects an exact same-run child and parent terminal relationship', async () => {
    const { authority, database, runtime } = harness()
    runtime.listMobileSessionTabs.mockResolvedValue(parentChildSession())
    attachLinkLease(database)
    attachParentLinkLease(database)
    publishLinkGraph(database, { parentChild: true })

    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing parent-child snapshot')
    }
    const link = current.snapshot.automatic_links.find(
      (candidate) => candidate.link_type === 'parent-child'
    )
    if (!link) {
      throw new Error('missing parent-child link')
    }
    expect(link).toMatchObject({
      authority_kind: 'parent-child-receipt',
      authority_id: 'run-1:edge-child-spawned-by-parent',
      explanation_code: 'parent-child'
    })
    expect(current.snapshot.surfaces[link.source_surface_key]?.id.unified_tab_id).toBe(
      'terminal-tab-1'
    )
    expect(current.snapshot.surfaces[link.target_surface_key]?.id.unified_tab_id).toBe(
      'terminal-tab-parent'
    )
    database.close()
  })

  it('drops unresolved, cross-scope, and ambiguous receipt relationships', async () => {
    const crossScope = harness()
    crossScope.runtime.listMobileSessionTabs.mockResolvedValue(linkedSession())
    attachLinkLease(crossScope.database)
    publishLinkGraph(crossScope.database, { browserIdentity: { workspaceKey: 'folder:other' } })
    const unavailableEdge = await crossScope.authority.query(scope, 'actor-1')
    expect(
      unavailableEdge.status === 'available' && unavailableEdge.snapshot.automatic_links
    ).toEqual([])
    crossScope.database.close()

    const ambiguous = harness()
    const duplicatePage = linkedSession()
    duplicatePage.tabs.push({
      type: 'browser',
      id: 'browser-tab-duplicate',
      title: 'Duplicate page',
      browserWorkspaceId: 'browser-workspace-duplicate',
      browserPageId: 'browser-page-1',
      url: 'https://example.com',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      isActive: false
    })
    duplicatePage.tabGroups![0]!.tabOrder.push('browser-tab-duplicate')
    ambiguous.runtime.listMobileSessionTabs.mockResolvedValue(duplicatePage)
    attachLinkLease(ambiguous.database)
    publishLinkGraph(ambiguous.database)
    const ambiguousEdge = await ambiguous.authority.query(scope, 'actor-1')
    expect(ambiguousEdge.status === 'available' && ambiguousEdge.snapshot.automatic_links).toEqual(
      []
    )
    ambiguous.database.close()
  })

  it.each([
    ['run', { runId: 'run-other' }],
    ['task', { taskId: 'MWC-OTHER' }],
    ['attempt', { attemptId: 'attempt-other-001' }],
    ['agent', { agentId: 'codex-other' }]
  ] as const)(
    'drops a graph edge when the exact %s receipt identity differs',
    async (_, browserIdentity) => {
      const { authority, database, runtime } = harness()
      runtime.listMobileSessionTabs.mockResolvedValue(linkedSession())
      attachLinkLease(database)
      publishLinkGraph(database, { browserIdentity })
      const current = await authority.query(scope, 'actor-1')
      expect(current.status === 'available' && current.snapshot.automatic_links).toEqual([])
      database.close()
    }
  )

  it('does not infer suggestions from tab adjacency without formal authority', async () => {
    const { authority, database, runtime } = harness()
    runtime.listMobileSessionTabs.mockResolvedValue(linkedSession())
    attachLinkLease(database)
    publishLinkGraph(database, { revision: 11 })
    const current = await authority.query(scope, 'actor-1')
    if (current.status !== 'available') {
      throw new Error('missing suggestion snapshot')
    }
    expect(current.snapshot.suggested_links).toEqual([])
    database.close()
  })
})

describe('Maestro workspace Canvas RPC schema', () => {
  it('requires actor, revision, and idempotency on every mutation', () => {
    const method = MAESTRO_WORKSPACE_CANVAS_METHODS.find(
      (candidate) => candidate.name === 'maestro.workspaceCanvas.mutate'
    )
    expect(
      method?.params?.safeParse({ action: 'create', scope, surface_type: 'terminal' }).success
    ).toBe(false)
  })

  it('accepts only bounded link intent and rejects spoofed provenance', () => {
    const method = MAESTRO_WORKSPACE_CANVAS_METHODS.find(
      (candidate) => candidate.name === 'maestro.workspaceCanvas.mutate'
    )
    const base = {
      action: 'create-manual-link',
      scope,
      actor_id: 'actor-1',
      expected_authority_revision: 1,
      expected_canvas_revision: 1,
      idempotency_key: 'link-1',
      source_surface_key: 'source',
      target_surface_key: 'target',
      link_type: 'context-for',
      label: null
    }
    expect(method?.params?.safeParse(base).success).toBe(true)
    expect(
      method?.params?.safeParse({
        ...base,
        author_id: 'forged',
        created_at: new Date().toISOString()
      }).success
    ).toBe(false)
    expect(
      method?.params?.safeParse({ ...base, expected_canvas_revision: undefined }).success
    ).toBe(false)
  })
})
