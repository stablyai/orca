import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import type { MaestroPrincipal } from '../../../../../shared/maestro-actor'
import type {
  DelegationIntent,
  MaestroContextSnapshot,
  MaestroDocumentAuthoringMutation,
  MaestroDocumentReadScope,
  MaestroDocumentLayoutMutation,
  MaestroMutation,
  MaestroWorkspaceAnchor
} from '../../../../../shared/maestro-contract'
import { parseStoredDocument } from './maestro-document-store-core'

const workspace = {
  repository_id: 'repo-1',
  execution_host_id: 'native',
  workspace_key: 'folder:folder-1',
  run_id: 'run-1'
}
const principal: MaestroPrincipal = {
  actor_id: 'user-1',
  kind: 'user',
  authenticated: true,
  session_id: 'session-1',
  workspace: { execution_host_id: 'native', workspace_key: 'folder:folder-1', run_id: 'run-1' }
}

function mutation(mutationId: string, expectedRevision: number): MaestroMutation {
  return {
    schema_version: 1,
    protocol: 'maestro-mutation/v1',
    mutation_id: mutationId,
    workspace,
    actor: { actor_id: 'forged', kind: 'system', authenticated: true, session_id: 'forged' },
    coordinator_generation: 1,
    expected_revision: expectedRevision,
    operation: { kind: 'move-node', node_id: 'node-1', position: { x: 10, y: 20 } }
  }
}

function layoutMutation(
  mutationId: string,
  expectedRevision: number,
  operation: MaestroDocumentLayoutMutation['operation'] = {
    kind: 'move-node',
    node_id: 'node-1',
    position: { x: 10, y: 20 }
  }
): MaestroDocumentLayoutMutation {
  return {
    schema_version: 1,
    protocol: 'maestro-document-layout-mutation/v1',
    mutation_id: mutationId,
    scope: {
      execution_host_id: workspace.execution_host_id,
      workspace_key: workspace.workspace_key
    },
    expected_revision: expectedRevision,
    operation
  }
}

function authoringMutation(
  scope: MaestroWorkspaceAnchor,
  mutationId: string,
  expectedRevision: number,
  operation: MaestroDocumentAuthoringMutation['operation']
): MaestroDocumentAuthoringMutation {
  return {
    schema_version: 1,
    protocol: 'maestro-document-authoring-mutation/v1',
    mutation_id: mutationId,
    scope,
    expected_revision: expectedRevision,
    operation
  }
}

function snapshotMetadata(
  noteId: string,
  revision: number,
  title: string,
  markdown: string
): MaestroContextSnapshot {
  const hash = createHash('sha256').update(markdown, 'utf8').digest('hex')
  return {
    note_id: noteId,
    revision: `note-${revision}`,
    content_hash: `sha256:${hash}`,
    media_type: 'text/markdown',
    title,
    snapshot_path: `maestro/context/${noteId}/${revision}.md`,
    byte_count: Buffer.byteLength(markdown, 'utf8')
  }
}

function delegationIntent(
  intentId: string,
  intentWorkspace: MaestroWorkspaceAnchor,
  coordinatorGeneration: number
): DelegationIntent {
  return {
    schema_version: 1,
    protocol: 'delegation-intent/v1',
    intent_id: intentId,
    workspace: intentWorkspace,
    actor: { actor_id: 'forged', kind: 'system', authenticated: true, session_id: 'forged' },
    coordinator_generation: coordinatorGeneration,
    expected_revision: 0,
    parent_task_id: 'task-1',
    parent_attempt_id: 'attempt-1',
    purpose: 'Run bounded work',
    role: 'implementation',
    requested: { lane: 'balanced', agent: null, model: null, effort: 'medium' },
    placement_request: { kind: 'current-workspace' },
    context_refs: [],
    paths: ['src/shared/maestro-contract.ts'],
    check: 'pnpm test'
  }
}

describe('Maestro document store', () => {
  it('reads empty and persisted documents without creating rows', () => {
    const db = new OrchestrationDb(':memory:')
    const scope: MaestroDocumentReadScope = {
      execution_host_id: workspace.execution_host_id,
      workspace_key: workspace.workspace_key
    }

    expect(db.getMaestroDocument(scope)).toEqual({
      state: 'empty',
      revision: null,
      document: null,
      updatedAt: null
    })
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM maestro_documents').get()).toEqual({
      count: 0
    })

    db.applyMaestroMutation(mutation('mutation-1', 0), principal)
    expect(db.getMaestroDocument(scope)).toMatchObject({
      state: 'ready',
      revision: 1,
      document: { nodes: { 'node-1': { position: { x: 10, y: 20 } } } }
    })
    db.close()
  })

  it('deduplicates mutations and fences stale revisions', () => {
    const db = new OrchestrationDb(':memory:')
    expect(db.applyMaestroMutation(mutation('mutation-1', 0), principal)).toMatchObject({
      outcome: 'applied',
      revision: 1
    })
    expect(db.applyMaestroMutation(mutation('mutation-1', 0), principal)).toMatchObject({
      outcome: 'applied',
      revision: 1
    })
    expect(db.applyMaestroMutation(mutation('mutation-2', 0), principal)).toEqual({
      outcome: 'conflict',
      revision: 1,
      resetRequired: true
    })
    expect(db.getMaestroDeltas(workspace, 0)).toMatchObject({ resetRequired: false, revision: 1 })
    db.close()
  })

  it('persists pair-scoped layout without a run anchor', () => {
    const db = new OrchestrationDb(':memory:')
    expect(
      db.applyMaestroDocumentLayoutMutation(
        layoutMutation('layout-1', 0, {
          kind: 'set-viewport',
          viewport: { center: { x: 100, y: -50 }, zoom: 1.5 }
        }),
        principal
      )
    ).toEqual({ outcome: 'applied', revision: 1, affectedIds: [] })
    expect(
      db.getMaestroDocument({
        execution_host_id: workspace.execution_host_id,
        workspace_key: workspace.workspace_key
      })
    ).toMatchObject({
      state: 'ready',
      revision: 1,
      document: { nodes: {}, viewport: { center: { x: 100, y: -50 }, zoom: 1.5 } }
    })
    db.close()
  })

  it('binds a layout-first document once through an anchored authoring mutation', () => {
    const directDb = new OrchestrationDb(':memory:')
    directDb.applyMaestroMutation(mutation('direct-1', 0), principal)
    expect(
      directDb.db
        .prepare(
          'SELECT run_id FROM maestro_documents WHERE execution_host_id = ? AND workspace_key = ?'
        )
        .get(workspace.execution_host_id, workspace.workspace_key)
    ).toEqual({ run_id: workspace.run_id })
    directDb.close()

    const layoutFirstDb = new OrchestrationDb(':memory:')
    layoutFirstDb.applyMaestroDocumentLayoutMutation(layoutMutation('layout-first-1', 0), principal)
    expect(
      layoutFirstDb.db
        .prepare(
          'SELECT run_id FROM maestro_documents WHERE execution_host_id = ? AND workspace_key = ?'
        )
        .get(workspace.execution_host_id, workspace.workspace_key)
    ).toEqual({ run_id: null })
    expect(
      layoutFirstDb.applyMaestroDocumentAuthoringMutation(
        authoringMutation(workspace, 'bind-layout-first', 1, {
          kind: 'create-note',
          node_id: 'bound-note',
          position: { x: 1, y: 1 },
          title: 'Bound',
          markdown: '# Bound'
        }),
        principal
      )
    ).toMatchObject({ outcome: 'applied', revision: 2 })
    expect(layoutFirstDb.getMaestroDeltas(workspace, 0)).toMatchObject({
      resetRequired: false,
      revision: 2
    })
    expect(
      layoutFirstDb.db
        .prepare(
          'SELECT run_id FROM maestro_documents WHERE execution_host_id = ? AND workspace_key = ?'
        )
        .get(workspace.execution_host_id, workspace.workspace_key)
    ).toEqual({ run_id: workspace.run_id })

    const otherRun = { ...workspace, run_id: 'run-other' }
    expect(() => layoutFirstDb.getMaestroDeltas(otherRun, 0)).toThrow('bound to a different run')
    expect(
      layoutFirstDb.db
        .prepare(
          'SELECT run_id FROM maestro_documents WHERE execution_host_id = ? AND workspace_key = ?'
        )
        .get(workspace.execution_host_id, workspace.workspace_key)
    ).toEqual({ run_id: workspace.run_id })
    layoutFirstDb.close()
  })

  it('replays layout receipts and rejects divergent or stale writes', () => {
    const db = new OrchestrationDb(':memory:')
    const first = layoutMutation('layout-1', 0)
    expect(db.applyMaestroDocumentLayoutMutation(first, principal)).toEqual({
      outcome: 'applied',
      revision: 1,
      affectedIds: ['node-1']
    })
    expect(db.applyMaestroDocumentLayoutMutation(first, principal)).toEqual({
      outcome: 'applied',
      revision: 1,
      affectedIds: ['node-1']
    })
    expect(() =>
      db.applyMaestroDocumentLayoutMutation(
        { ...first, operation: { kind: 'move-node', node_id: 'node-2', position: { x: 1, y: 2 } } },
        principal
      )
    ).toThrow('reused with different input')
    expect(db.applyMaestroDocumentLayoutMutation(layoutMutation('layout-2', 0), principal)).toEqual(
      {
        outcome: 'conflict',
        revision: 1,
        resetRequired: true
      }
    )
    expect(
      db.getMaestroDocument({
        execution_host_id: workspace.execution_host_id,
        workspace_key: workspace.workspace_key
      })
    ).toMatchObject({ document: { nodes: { 'node-1': { position: { x: 10, y: 20 } } } } })
    db.close()
  })

  it('rederives run snapshots from durable notes and rejects forged authority', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Authoring authority',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const runWorkspace = { ...workspace, run_id: run.id }
    const scope: MaestroWorkspaceAnchor = runWorkspace
    const authoringPrincipal: MaestroPrincipal = {
      ...principal,
      workspace: { ...principal.workspace, run_id: run.id }
    }
    db.applyMaestroMutation(
      { ...mutation('authoring-bind-run', 0), workspace: runWorkspace },
      authoringPrincipal
    )
    expect(
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'author-note-1', 1, {
          kind: 'create-note',
          node_id: 'note-1',
          position: { x: 10, y: 20 },
          title: 'Durable note',
          markdown: '# First'
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 2 })
    const metadata = snapshotMetadata('note-1', 1, 'Durable note', '# First')
    const pin = (
      mutationId: string,
      expectedRevision: number,
      snapshot: MaestroContextSnapshot
    ): MaestroMutation => ({
      schema_version: 1,
      protocol: 'maestro-mutation/v1',
      mutation_id: mutationId,
      workspace: runWorkspace,
      actor: { actor_id: 'forged', kind: 'system', authenticated: true, session_id: 'forged' },
      coordinator_generation: run.consumer_generation,
      expected_revision: expectedRevision,
      operation: { kind: 'pin-note-snapshot', task_id: 'note-1', snapshot }
    })
    expect(() =>
      db.applyMaestroMutation(
        pin('pin-forged-hash', 2, { ...metadata, content_hash: `sha256:${'f'.repeat(64)}` }),
        authoringPrincipal
      )
    ).toThrow('not authoritative')
    expect(
      db.applyMaestroMutation(pin('pin-valid', 2, metadata), authoringPrincipal)
    ).toMatchObject({ outcome: 'applied', revision: 3 })
    expect(
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'author-note-2', 3, {
          kind: 'update-note',
          node_id: 'note-1',
          expected_note_revision: 1,
          title: 'Durable note',
          markdown: '# Second'
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 4 })
    expect(() =>
      db.applyMaestroMutation(pin('pin-stale', 4, metadata), authoringPrincipal)
    ).toThrow('stale or not a note endpoint')
    expect(
      db.applyMaestroDocumentLayoutMutation(
        layoutMutation('layout-node', 4, {
          kind: 'move-node',
          node_id: 'layout-1',
          position: { x: 1, y: 2 }
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 5 })
    expect(() =>
      db.applyMaestroMutation(
        pin('pin-layout', 5, snapshotMetadata('layout-1', 1, 'Layout', '')),
        authoringPrincipal
      )
    ).toThrow('stale or not a note endpoint')
    db.close()
  })

  it('binds pair authoring to a server-owned run and preserves linked snapshot content', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Linked authoring',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const runWorkspace = { ...workspace, run_id: run.id }
    const scope: MaestroWorkspaceAnchor = runWorkspace
    const authoringPrincipal: MaestroPrincipal = {
      ...principal,
      workspace: { ...principal.workspace, run_id: run.id }
    }
    db.applyMaestroMutation(
      { ...mutation('bind-run', 0), workspace: runWorkspace },
      authoringPrincipal
    )
    expect(
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'linked-note', 1, {
          kind: 'create-note',
          node_id: 'linked-note',
          position: { x: 10, y: 20 },
          title: 'Linked note',
          markdown: '# Original'
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 2 })
    expect(
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'linked-edge', 2, {
          kind: 'create-edge',
          id: 'linked-edge',
          source_id: 'node-1',
          target_id: 'linked-note',
          type: 'context_for',
          direction: 'forward',
          context_note_id: 'linked-note',
          expected_note_revision: 1
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 3 })
    const edge = db.getMaestroDocument(scope).document?.edges[0]
    const snapshotId = edge?.context_snapshot_id
    expect(snapshotId).toBeTruthy()
    const coordinator: MaestroPrincipal = {
      actor_id: 'coordinator-1',
      kind: 'coordinator',
      authenticated: true,
      session_id: 'session-1',
      generation: run.consumer_generation,
      workspace: {
        execution_host_id: runWorkspace.execution_host_id,
        workspace_key: runWorkspace.workspace_key,
        run_id: run.id
      }
    }
    expect(db.getMaestroContextSnapshot(snapshotId!, coordinator)?.markdown).toBe('# Original')
    expect(
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'linked-update', 3, {
          kind: 'update-note',
          node_id: 'linked-note',
          expected_note_revision: 1,
          title: 'Linked note',
          markdown: '# Edited'
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 4 })
    expect(db.getMaestroContextSnapshot(snapshotId!, coordinator)?.snapshot).toMatchObject(
      snapshotMetadata('linked-note', 1, 'Linked note', '# Original')
    )
    expect(db.getMaestroContextSnapshot(snapshotId!, coordinator)?.markdown).toBe('# Original')
    expect(() =>
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'outside-edge', 4, {
          kind: 'create-edge',
          id: 'outside-edge',
          source_id: 'node-1',
          target_id: 'linked-note',
          type: 'context_for',
          direction: 'forward',
          context_note_id: 'node-1',
          expected_note_revision: 1
        }),
        authoringPrincipal
      )
    ).toThrow('current note endpoint revision')
    expect(() =>
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'stale-edge', 4, {
          kind: 'create-edge',
          id: 'stale-edge',
          source_id: 'node-1',
          target_id: 'linked-note',
          type: 'context_for',
          direction: 'forward',
          context_note_id: 'linked-note',
          expected_note_revision: 1
        }),
        authoringPrincipal
      )
    ).toThrow('current note endpoint revision')
    const otherRun = db.createRun({
      objective: 'Other authoring run',
      coordinatorHandle: 'coordinator-2',
      coordinatorPaneKey: 'tab-2:leaf-1'
    })
    const otherScope: MaestroWorkspaceAnchor = { ...scope, run_id: otherRun.id }
    const otherPrincipal: MaestroPrincipal = {
      ...authoringPrincipal,
      workspace: { ...authoringPrincipal.workspace, run_id: otherRun.id }
    }
    expect(() =>
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(otherScope, 'cross-run-note', 4, {
          kind: 'create-note',
          node_id: 'cross-run-note',
          position: { x: 1, y: 1 },
          title: 'Cross run',
          markdown: '# Cross run'
        }),
        otherPrincipal
      )
    ).toThrow('bound to a different run')
    const unbound = new OrchestrationDb(':memory:')
    expect(
      unbound.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'unbound-note', 0, {
          kind: 'create-note',
          node_id: 'unbound-note',
          position: { x: 1, y: 2 },
          title: 'Unbound',
          markdown: '# Unbound'
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 1 })
    expect(
      unbound.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'unbound-target', 1, {
          kind: 'create-note',
          node_id: 'unbound-target',
          position: { x: 3, y: 4 },
          title: 'Target',
          markdown: '# Target'
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 2 })
    expect(
      unbound.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'unbound-edge', 2, {
          kind: 'create-edge',
          id: 'unbound-edge',
          source_id: 'unbound-note',
          target_id: 'unbound-target',
          type: 'context_for',
          direction: 'forward',
          context_note_id: 'unbound-note',
          expected_note_revision: 1
        }),
        authoringPrincipal
      )
    ).toMatchObject({ outcome: 'applied', revision: 3 })
    unbound.close()
    db.close()
  })

  it('undoes and redoes a note without treating history bookkeeping as document drift', () => {
    const db = new OrchestrationDb(':memory:')
    const scope: MaestroWorkspaceAnchor = workspace
    expect(
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'author-note-undo', 0, {
          kind: 'create-note',
          node_id: 'note-undo',
          position: { x: 10, y: 20 },
          title: 'Undo note',
          markdown: '# Undo'
        }),
        principal
      )
    ).toMatchObject({ outcome: 'applied', revision: 1 })
    expect(
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'author-undo', 1, {
          kind: 'undo',
          target_mutation_id: 'author-note-undo'
        }),
        principal
      )
    ).toMatchObject({ outcome: 'applied', revision: 2 })
    expect(db.getMaestroDocument(scope)).toMatchObject({ document: { nodes: {} } })
    expect(
      db.applyMaestroDocumentAuthoringMutation(
        authoringMutation(scope, 'author-redo', 2, {
          kind: 'redo',
          target_mutation_id: 'author-note-undo'
        }),
        principal
      )
    ).toMatchObject({ outcome: 'applied', revision: 3 })
    expect(db.getMaestroDocument(scope)).toMatchObject({
      document: {
        nodes: { 'note-undo': { title: 'Undo note', markdown: '# Undo', note_revision: 1 } },
        authoring_history: { undo_stack: ['author-note-undo'], redo_stack: [] }
      }
    })
    db.close()
  })

  it('fails closed when durable document JSON is malformed', () => {
    expect(() => parseStoredDocument('{"nodes":')).toThrowError(
      expect.objectContaining({ name: 'OrchestrationError', code: 'integrity_error' })
    )
  })

  it('rejects divergent intent replay without mutating the stored request', () => {
    const db = new OrchestrationDb(':memory:')
    const intent = delegationIntent('intent-1', workspace, 1)

    expect(db.requestMaestroDelegationIntent(intent, principal)).toEqual({
      intentId: 'intent-1',
      state: 'pending'
    })
    expect(db.requestMaestroDelegationIntent({ ...intent }, principal)).toEqual({
      intentId: 'intent-1',
      state: 'pending'
    })
    expect(() =>
      db.requestMaestroDelegationIntent({ ...intent, purpose: 'Different work' }, principal)
    ).toThrow('reused with different input')
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM maestro_delegation_intents').get()).toEqual(
      { count: 1 }
    )
    db.close()
  })

  it('fences intent take and settlement to stored scope and generation', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Test Maestro authority',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const intentWorkspace = { ...workspace, run_id: run.id }
    const intent = delegationIntent('intent-1', intentWorkspace, run.consumer_generation)
    const coordinator: MaestroPrincipal = {
      ...principal,
      actor_id: 'coordinator-1',
      kind: 'coordinator',
      generation: run.consumer_generation,
      workspace: {
        execution_host_id: intentWorkspace.execution_host_id,
        workspace_key: intentWorkspace.workspace_key,
        run_id: run.id
      }
    }
    db.requestMaestroDelegationIntent(intent, principal)

    for (const denied of [
      { ...coordinator, generation: run.consumer_generation + 1 },
      {
        ...coordinator,
        workspace: { ...coordinator.workspace, execution_host_id: 'ssh:other' }
      },
      {
        ...coordinator,
        workspace: { ...coordinator.workspace, workspace_key: 'folder:folder-2' }
      },
      { ...coordinator, workspace: { ...coordinator.workspace, run_id: 'run-other' } }
    ]) {
      expect(db.takeMaestroDelegationIntent(intent.intent_id, denied)).toBeUndefined()
    }

    expect(db.takeMaestroDelegationIntent(intent.intent_id, coordinator)).toEqual(intent)
    expect(
      db.settleMaestroDelegationIntent(
        intent.intent_id,
        {
          ...coordinator,
          generation: run.consumer_generation + 1
        },
        { attemptId: 'attempt-1' }
      )
    ).toBe(false)
    expect(
      db.settleMaestroDelegationIntent(intent.intent_id, coordinator, {
        attemptId: 'attempt-1'
      })
    ).toBe(true)
    expect(() =>
      db.settleMaestroDelegationIntent(intent.intent_id, coordinator, {
        attemptId: 'attempt-2'
      })
    ).toThrow('different receipt')
    db.db
      .prepare('UPDATE runs SET consumer_generation = consumer_generation + 1 WHERE id = ?')
      .run(run.id)
    expect(
      db.settleMaestroDelegationIntent(intent.intent_id, coordinator, {
        attemptId: 'attempt-1'
      })
    ).toBe(false)
    db.close()
  })

  it('fetches and releases snapshots only for the owning current coordinator', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Test snapshot lifecycle',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab-1:leaf-1'
    })
    const snapshotWorkspace = { ...workspace, run_id: run.id }
    const snapshotId = db.pinMaestroContextSnapshot({
      scope: snapshotWorkspace,
      nodeId: 'note-1',
      noteRevision: 1,
      title: 'Pinned context',
      content: 'Pinned context',
      ownerPrincipal: 'user-1'
    })
    const coordinator: MaestroPrincipal = {
      ...principal,
      actor_id: 'coordinator-1',
      kind: 'coordinator',
      generation: run.consumer_generation,
      workspace: {
        execution_host_id: snapshotWorkspace.execution_host_id,
        workspace_key: snapshotWorkspace.workspace_key,
        run_id: run.id
      }
    }

    expect(db.getMaestroContextSnapshot(snapshotId, coordinator)).toMatchObject({
      snapshotId,
      nodeId: 'note-1',
      snapshot: { note_id: 'note-1', revision: 'note-1' },
      markdown: 'Pinned context'
    })
    expect(
      db.getMaestroContextSnapshot(snapshotId, {
        ...coordinator,
        workspace: { ...coordinator.workspace, workspace_key: 'folder:folder-2' }
      })
    ).toBeUndefined()
    expect(
      db.releaseMaestroContextSnapshot(snapshotId, {
        ...coordinator,
        generation: run.consumer_generation + 1
      })
    ).toBe(false)
    for (const denied of [
      {
        ...coordinator,
        workspace: { ...coordinator.workspace, execution_host_id: 'ssh:other' }
      },
      {
        ...coordinator,
        workspace: { ...coordinator.workspace, workspace_key: 'folder:folder-2' }
      },
      { ...coordinator, workspace: { ...coordinator.workspace, run_id: 'run-other' } }
    ]) {
      expect(db.releaseMaestroContextSnapshot(snapshotId, denied)).toBe(false)
    }
    expect(db.releaseMaestroContextSnapshot(snapshotId, coordinator)).toBe(true)
    expect(db.releaseMaestroContextSnapshot(snapshotId, coordinator)).toBe(true)
    expect(db.getMaestroContextSnapshot(snapshotId, coordinator)).toBeUndefined()
    db.close()
  })
})
