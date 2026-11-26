import type Database from '../../../sqlite/sync-database'
import { compilePipelineV2 } from '../../../../shared/pipelines/v2/pipeline-v2-compiler'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import {
  PipelineV2Admission,
  PipelineV2Run
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { PipelineV2Mutation } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import {
  PipelineV2Event,
  PipelineV2Receipt,
  type PipelineV2EventPage
} from '../../../../shared/pipelines/v2/pipeline-v2-results'
import { transitionPipelineV2 } from './pipeline-v2-state'
import { pipelineV2RunPage } from './pipeline-v2-run-queries'
import { PipelineV2OwnerHistory } from './pipeline-v2-owner-history'

export function assertPipelineV2SchemaSupported(db: Database.Database): void {
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('pipeline_schema')
  ) {
    return
  }
  for (const [component, version] of [
    ['pipelines-v2', 3],
    ['pipelines-v2-library', 2],
    ['pipelines-v2-requests', 1],
    ['pipelines-v2-decisions', 1]
  ] as const) {
    const row = db.prepare('SELECT version FROM pipeline_schema WHERE component=?').get(component)
    if (
      row &&
      row.version !== version &&
      !(component === 'pipelines-v2' && row.version === 2) &&
      !(component === 'pipelines-v2-library' && row.version === 1)
    ) {
      throw new Error('pipeline_schema_unsupported')
    }
  }
}

export class PipelineV2Journal {
  readonly decisions: PipelineV2OwnerHistory
  constructor(private readonly db: Database.Database) {
    assertPipelineV2SchemaSupported(db)
    db.exec('SAVEPOINT pipeline_v2_schema')
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS pipeline_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS pipeline_runs_v2 (id TEXT PRIMARY KEY, instance_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pipeline_requests_v2 (request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS pipeline_events_v2 (run_id TEXT NOT NULL, sequence INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, sequence));`)
      db.prepare('INSERT OR REPLACE INTO pipeline_schema (component, version) VALUES (?, ?)').run(
        'pipelines-v2',
        3
      )
      this.decisions = new PipelineV2OwnerHistory(db)
      db.exec('RELEASE pipeline_v2_schema')
    } catch (error) {
      db.exec('ROLLBACK TO pipeline_v2_schema')
      db.exec('RELEASE pipeline_v2_schema')
      throw error
    }
  }

  has(id: string): boolean {
    return Boolean(this.db.prepare('SELECT id FROM pipeline_runs_v2 WHERE id = ?').get(id))
  }
  page(projectId: string, cursor: number, limit: number) {
    return pipelineV2RunPage(this.db, projectId, cursor, limit)
  }

  bound(instanceId: string): boolean {
    return Boolean(
      this.db.prepare('SELECT id FROM pipeline_runs_v2 WHERE instance_id = ?').get(instanceId)
    )
  }

  get(id: string): PipelineV2Run {
    const row = this.db.prepare('SELECT data FROM pipeline_runs_v2 WHERE id = ?').get(id)
    if (typeof row?.data !== 'string') {
      throw new Error('pipeline_not_found')
    }
    return PipelineV2Run.parse(JSON.parse(row.data))
  }

  list(pending = false): PipelineV2Run[] {
    return this.db
      .prepare(
        pending
          ? "SELECT data FROM pipeline_runs_v2 WHERE json_extract(data, '$.state') NOT IN ('completed', 'failed') ORDER BY rowid LIMIT 50"
          : 'SELECT data FROM pipeline_runs_v2 ORDER BY rowid DESC LIMIT 50'
      )
      .all()
      .map((row) => PipelineV2Run.parse(JSON.parse(String(row.data))))
  }

  create(input: unknown): PipelineV2Run {
    const parsed = PipelineV2Admission.parse(input)
    const { digest, engineVersion: _engine, ...template } = parsed.definition
    if (
      compilePipelineV2(template).digest !== digest ||
      parsed.workspace.projectId !== parsed.definition.projectId
    ) {
      throw new Error('pipeline_definition_snapshot_mismatch')
    }
    return this.request(parsed.id, parsed.requestId, parsed, 'create', 0, () => {
      if (this.db.prepare('SELECT id FROM pipeline_runs WHERE id = ?').get(parsed.id)) {
        throw new Error('pipeline_run_identity_conflict')
      }
      const existing = this.db
        .prepare('SELECT id FROM pipeline_runs WHERE instance_id = ?')
        .get(parsed.workspace.instanceId)
      if (existing || this.bound(parsed.workspace.instanceId)) {
        throw new Error('pipeline_workspace_already_bound')
      }
      const active = this.db
        .prepare(`SELECT
        (SELECT count(*) FROM pipeline_runs WHERE json_extract(data, '$.state') NOT IN ('ready_for_review', 'failed')) +
        (SELECT count(*) FROM pipeline_runs_v2 WHERE json_extract(data, '$.state') NOT IN ('completed', 'failed')) AS count`)
        .get()
      if (Number(active?.count) >= 50) {
        throw new Error('pipeline_active_run_limit')
      }
      const { requestId: _request, waitForSetup, ...admission } = parsed
      const visitId = `${parsed.id}:visit:1`
      const run = PipelineV2Run.parse({
        ...admission,
        engineVersion: 2,
        definitionDigest: digest,
        definitionEnabled: true,
        revision: 0,
        eventSequence: 1,
        state: waitForSetup ? 'waiting_setup' : 'running',
        ...(waitForSetup ? { setupHold: {} } : {}),
        stageId: parsed.definition.entryStageId,
        currentVisitId: visitId,
        visits: [
          {
            id: visitId,
            stageId: parsed.definition.entryStageId,
            attempt: 0,
            state: 'pending',
            discussionTurns: 0,
            candidateIds: []
          }
        ],
        invocations: [],
        candidates: [],
        usedInvocations: 0,
        budgetExtensions: [],
        sessionGroups: {}
      })
      this.db
        .prepare('INSERT INTO pipeline_runs_v2 (id, instance_id, data) VALUES (?, ?, ?)')
        .run(run.id, run.workspace.instanceId, JSON.stringify(run))
      return run
    })
  }

  command(id: string, input: unknown): PipelineV2Run {
    const parsed = PipelineV2Mutation.parse(input)
    return this.request(
      id,
      parsed.requestId,
      { id, ...parsed },
      parsed.command.kind,
      parsed.expectedRevision,
      () => {
        const run = this.get(id)
        if (run.workspace.instanceId !== parsed.expectedInstanceId) {
          throw new Error('pipeline_workspace_instance_changed')
        }
        if (run.revision !== parsed.expectedRevision) {
          throw new Error('pipeline_revision_conflict')
        }
        const next = transitionPipelineV2(run, parsed)
        next.revision++
        next.eventSequence++
        const checked = PipelineV2Run.parse(next)
        this.decisions.record(run, parsed, checked)
        this.db
          .prepare('UPDATE pipeline_runs_v2 SET data = ? WHERE id = ?')
          .run(JSON.stringify(checked), id)
        return checked
      },
      parsed.command.kind === 'decide'
        ? { id: parsed.command.candidateId, digest: parsed.command.candidateDigest }
        : undefined
    )
  }

  receipt(id: string, requestId: string): PipelineV2Receipt | null {
    const row = this.db
      .prepare('SELECT receipt FROM pipeline_requests_v2 WHERE request_id = ? AND run_id = ?')
      .get(requestId, id)
    return typeof row?.receipt === 'string'
      ? PipelineV2Receipt.parse(JSON.parse(row.receipt))
      : null
  }

  requestRun(requestId: string): PipelineV2Run | undefined {
    const row = this.db
      .prepare('SELECT run_id FROM pipeline_requests_v2 WHERE request_id = ?')
      .get(requestId)
    return typeof row?.run_id === 'string' ? this.get(row.run_id) : undefined
  }

  events(id: string, cursor = 0, limit = 50): PipelineV2EventPage {
    if (
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new Error('pipeline_cursor_invalid')
    }
    const run = this.get(id)
    const rows = this.db
      .prepare(
        'SELECT data FROM pipeline_events_v2 WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?'
      )
      .all(id, cursor, limit + 1)
    const events = rows
      .slice(0, limit)
      .map((row) => PipelineV2Event.parse(JSON.parse(String(row.data))))
    return {
      events,
      cursor: events.at(-1)?.sequence ?? cursor,
      hasMore: rows.length > limit,
      latestSequence: run.eventSequence
    }
  }

  private request(
    id: string,
    requestId: string,
    payload: unknown,
    kind: string,
    inputRevision: number,
    apply: () => PipelineV2Run,
    decidedCandidate?: { id: string; digest: string }
  ): PipelineV2Run {
    const digest = pipelineV2Fingerprint(payload)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db
        .prepare('SELECT run_id, digest FROM pipeline_requests_v2 WHERE request_id = ?')
        .get(requestId)
      if (previous) {
        if (previous.run_id !== id || previous.digest !== digest) {
          throw new Error('pipeline_request_conflict')
        }
        const current = this.get(id)
        this.db.exec('COMMIT')
        return current
      }
      const run = apply()
      const receipt = PipelineV2Receipt.parse({
        runId: id,
        requestId,
        inputRevision,
        acceptedRevision: run.revision,
        kind,
        payloadDigest: digest,
        definitionDigest: run.definitionDigest,
        workspaceInstanceId: run.workspace.instanceId,
        state: run.state,
        stageId: run.stageId,
        eventSequence: run.eventSequence,
        sourceRevision: run.sourceRevision,
        ...(decidedCandidate
          ? { candidateId: decidedCandidate.id, candidateDigest: decidedCandidate.digest }
          : run.pendingDecision
            ? {
                candidateId: run.pendingDecision.candidateId,
                candidateDigest: run.pendingDecision.candidateDigest
              }
            : {})
      })
      const event = PipelineV2Event.parse({
        runId: id,
        workspaceInstanceId: run.workspace.instanceId,
        sequence: run.eventSequence,
        revision: run.revision,
        kind,
        stageId: run.stageId,
        visitId: run.currentVisitId,
        state: run.state,
        ...(run.reason ? { reason: run.reason } : {})
      })
      this.db
        .prepare(
          'INSERT INTO pipeline_requests_v2 (request_id, run_id, digest, receipt) VALUES (?, ?, ?, ?)'
        )
        .run(requestId, id, digest, JSON.stringify(receipt))
      this.db
        .prepare('INSERT INTO pipeline_events_v2 (run_id, sequence, data) VALUES (?, ?, ?)')
        .run(id, run.eventSequence, JSON.stringify(event))
      this.db.exec('COMMIT')
      return run
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
