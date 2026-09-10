import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MaestroBootstrapReceiptSchema } from '../../../../../shared/maestro-bootstrap-contract'
import type { AgentGraphView, MaestroWorkspaceAnchor } from '../../../../../shared/maestro-contract'
import { OrchestrationDb } from '../orchestration-db'
import {
  applyMaestroBootstrapProjection,
  applyMaestroProjection,
  getMaestroProjection,
  listMaestroProjectionIndex,
  listMaestroRunProgress,
  recordMaestroBootstrap,
  replayMaestroBootstrap
} from './maestro-projection-store'

const HOME = { execution_host_id: 'local', workspace_key: 'folder:home-1' }
const EXECUTION = { execution_host_id: 'ssh:build', workspace_key: 'worktree:repo-1::/srv/repo' }

function anchor(runId = 'run-1'): MaestroWorkspaceAnchor {
  return {
    repository_id: 'home-1',
    execution_host_id: HOME.execution_host_id,
    workspace_key: HOME.workspace_key,
    run_id: runId
  }
}

function view(overrides: Partial<AgentGraphView> = {}): AgentGraphView {
  return {
    schema_version: 1,
    protocol: 'agent-graph-view/v1',
    kind: 'snapshot',
    workspace_scope: {
      schema_version: 1,
      repository_id: 'home-1',
      canonical_root: '/workspace/home',
      execution_host: { id: EXECUTION.execution_host_id, boundary: 'remote' },
      orchestration_home: {
        ...HOME,
        kind: 'folder',
        path: '/workspace/home'
      },
      execution_workspace: {
        ...EXECUTION,
        kind: 'git-worktree',
        path: '/srv/repo',
        worktree_path: '/srv/repo'
      },
      base_revision: 'a'.repeat(40),
      dirty_paths: [],
      run_id: 'run-1',
      coordinator_generation: 2,
      binding_receipt_ref: 'artifact:workspace-bootstrap/mutation-1.json',
      binding_receipt_hash: `sha256:${'b'.repeat(64)}`
    },
    change: 'orchestration-run',
    run_id: 'run-1',
    coordinator: { id: 'coordinator-1', generation: 2 },
    capabilities: {
      agents: ['codex'],
      efforts: ['high'],
      placement_kinds: ['existing-workspace'],
      watch_deltas: true
    },
    nodes: [],
    edges: [],
    removed_node_ids: [],
    removed_edge_ids: [],
    revision: 0,
    cursor: null,
    from_cursor: null,
    reset_required: false,
    progress: undefined,
    ...overrides
  }
}

function runView(runId: string, overrides: Partial<AgentGraphView> = {}): AgentGraphView {
  const initial = view()
  return view({
    run_id: runId,
    workspace_scope: { ...initial.workspace_scope, run_id: runId },
    ...overrides
  })
}

describe('Maestro projection store', () => {
  it('publishes one strict projection to its home and execution scopes', () => {
    const database = new OrchestrationDb(':memory:')
    const projection = applyMaestroProjection.call(database, anchor(), view())

    expect(projection.revision).toBe(0)
    expect(getMaestroProjection.call(database, HOME)).toMatchObject({ runId: 'run-1' })
    expect(getMaestroProjection.call(database, EXECUTION)).toMatchObject({ runId: 'run-1' })
    expect(listMaestroProjectionIndex.call(database)).toHaveLength(1)
    expect(listMaestroRunProgress.call(database)).toHaveLength(1)
    database.close()
  })

  it('keeps exact Run projections and deltas after the database reopens', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-maestro-projection-'))
    const databasePath = join(directory, 'orchestration.sqlite')
    try {
      const firstDatabase = new OrchestrationDb(databasePath)
      applyMaestroProjection.call(firstDatabase, anchor('run-1'), runView('run-1'))
      const legacyProjection = firstDatabase.db
        .prepare(
          `SELECT run_id, revision, view_json, updated_at FROM maestro_run_projections
           WHERE run_id = 'run-1'`
        )
        .get() as { run_id: string; revision: number; view_json: string; updated_at: string }
      firstDatabase.db.exec(`
        DROP INDEX idx_maestro_run_projections_home;
        DROP INDEX idx_maestro_run_projections_execution;
        DROP TABLE maestro_run_projections;
        CREATE TABLE maestro_run_projections (
          execution_host_id TEXT NOT NULL,
          workspace_key TEXT NOT NULL,
          run_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          view_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (execution_host_id, workspace_key)
        );
        CREATE TABLE maestro_run_projection_records (rejected_attempt_data TEXT);
      `)
      const insertLegacy = firstDatabase.db.prepare(
        `INSERT INTO maestro_run_projections (
           execution_host_id, workspace_key, run_id, revision, view_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const scope of [HOME, EXECUTION]) {
        insertLegacy.run(
          scope.execution_host_id,
          scope.workspace_key,
          legacyProjection.run_id,
          legacyProjection.revision,
          legacyProjection.view_json,
          legacyProjection.updated_at
        )
      }
      insertLegacy.run(
        'local',
        'folder:broken',
        'run-broken',
        4,
        JSON.stringify({ run_id: 'run-broken', workspace_scope: {} }),
        legacyProjection.updated_at
      )
      firstDatabase.db.pragma('user_version = 34')
      firstDatabase.close()

      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const migratedDatabase = new OrchestrationDb(databasePath)
      expect(warning).toHaveBeenCalledTimes(1)
      expect(warning.mock.calls[0]?.[0]).toContain('quarantined malformed Maestro projection')
      warning.mockRestore()
      expect(getMaestroProjection.call(migratedDatabase, EXECUTION, 'run-1')).toMatchObject({
        runId: 'run-1',
        revision: 0
      })
      expect(
        migratedDatabase.db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'maestro_run_projection%'
             ORDER BY name`
          )
          .all()
      ).toEqual(
        expect.arrayContaining([
          { name: 'maestro_run_projection_migration_quarantine' },
          { name: 'maestro_run_projections' }
        ])
      )
      expect(
        migratedDatabase.db
          .prepare(
            `SELECT run_id, revision, reason, length(payload_sample) AS sample_length
             FROM maestro_run_projection_migration_quarantine`
          )
          .all()
      ).toEqual([
        expect.objectContaining({
          run_id: 'run-broken',
          revision: 4,
          sample_length: expect.any(Number)
        })
      ])
      expect(migratedDatabase.db.pragma('user_version', { simple: true })).toBeGreaterThanOrEqual(
        43
      )
      applyMaestroProjection.call(migratedDatabase, anchor('run-2'), runView('run-2'))
      applyMaestroProjection.call(
        migratedDatabase,
        anchor('run-1'),
        runView('run-1', {
          kind: 'delta',
          revision: 1
        })
      )
      expect(
        migratedDatabase.db.prepare('SELECT count(*) AS count FROM maestro_run_projections').get()
      ).toEqual({ count: 2 })
      migratedDatabase.close()

      const reopenedDatabase = new OrchestrationDb(databasePath)
      expect(getMaestroProjection.call(reopenedDatabase, EXECUTION, 'run-1')).toMatchObject({
        runId: 'run-1',
        revision: 1
      })
      expect(getMaestroProjection.call(reopenedDatabase, EXECUTION, 'run-2')).toMatchObject({
        runId: 'run-2',
        revision: 0,
        change: 'orchestration-run'
      })
      expect(listMaestroProjectionIndex.call(reopenedDatabase)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: 'run-1', revision: 1 }),
          expect.objectContaining({ runId: 'run-2', revision: 0 })
        ])
      )
      expect(
        reopenedDatabase.db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'maestro_run_projection%'
             ORDER BY name`
          )
          .all()
      ).toEqual(
        expect.arrayContaining([
          { name: 'maestro_run_projection_migration_quarantine' },
          { name: 'maestro_run_projections' }
        ])
      )
      reopenedDatabase.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects schema spread before persistence', () => {
    const database = new OrchestrationDb(':memory:')
    expect(() =>
      applyMaestroProjection.call(database, anchor(), { ...view(), caller_owned: true } as never)
    ).toThrow()
    expect(getMaestroProjection.call(database, HOME)).toBeNull()
    database.close()
  })

  it('replays an equivalent revision-zero bootstrap without overwriting it', () => {
    const database = new OrchestrationDb(':memory:')
    expect(applyMaestroBootstrapProjection.call(database, anchor(), view())).toBe('published')
    expect(applyMaestroBootstrapProjection.call(database, anchor(), view())).toBe('replayed')
    expect(listMaestroProjectionIndex.call(database)).toHaveLength(1)
    database.close()
  })

  it('replays the durable bootstrap receipt after database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-maestro-bootstrap-'))
    const databasePath = join(directory, 'orchestration.sqlite')
    const mutation = {
      mutation_id: 'mutation-1',
      execution_host_id: EXECUTION.execution_host_id,
      workspace_key: EXECUTION.workspace_key,
      run_id: 'run-1'
    }
    const request = {
      schema_version: 1 as const,
      protocol: 'maestro-bootstrap/v1' as const,
      mutation,
      coordinator_generation: 2
    }
    const receipt = MaestroBootstrapReceiptSchema.parse({
      schema_version: 1 as const,
      protocol: 'maestro-bootstrap-receipt/v1' as const,
      mutation,
      coordinator_generation: 2,
      workspace_scope: view().workspace_scope,
      projection_revision: 0 as const,
      outcome: 'published' as const
    })
    try {
      const firstDatabase = new OrchestrationDb(databasePath)
      recordMaestroBootstrap.call(firstDatabase, request, receipt)
      recordMaestroBootstrap.call(firstDatabase, request, receipt)
      firstDatabase.close()

      const reopenedDatabase = new OrchestrationDb(databasePath)
      expect(replayMaestroBootstrap.call(reopenedDatabase, request)).toEqual({
        ...receipt,
        outcome: 'replayed'
      })
      expect(() =>
        recordMaestroBootstrap.call(
          reopenedDatabase,
          { ...request, coordinator_generation: 3 },
          receipt
        )
      ).toThrow(/reused with different input/)
      reopenedDatabase.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects a conflicting base without preventing a newer Run in the same workspace', () => {
    const database = new OrchestrationDb(':memory:')
    applyMaestroBootstrapProjection.call(database, anchor(), view())

    const conflictingBase = view({
      workspace_scope: { ...view().workspace_scope, base_revision: 'c'.repeat(40) }
    })
    expect(() => applyMaestroBootstrapProjection.call(database, anchor(), conflictingBase)).toThrow(
      'conflicts'
    )
    const conflictingRun = view({
      run_id: 'run-2',
      workspace_scope: { ...view().workspace_scope, run_id: 'run-2' }
    })
    expect(applyMaestroBootstrapProjection.call(database, anchor('run-2'), conflictingRun)).toBe(
      'published'
    )
    expect(getMaestroProjection.call(database, HOME, 'run-1')).toMatchObject({
      runId: 'run-1',
      workspace: { executionHostId: 'local', workspaceKey: 'folder:home-1' }
    })
    expect(getMaestroProjection.call(database, HOME, 'run-2')).toMatchObject({ runId: 'run-2' })
    database.close()
  })
})
