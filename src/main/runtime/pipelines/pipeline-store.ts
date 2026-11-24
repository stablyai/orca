import { randomUUID } from 'node:crypto'
import { PipelineCreationJournal } from './pipeline-creation-journal'
import { assertPipelineCreationCapacity } from './pipeline-creation-capacity'
import type { PipelineV2Run } from '../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2Command } from '../../../shared/pipelines/v2/pipeline-v2-mutations'
import { readPipelineV2HistoryContext } from './v2/pipeline-v2-history-context'
import { invalidatePipelineV2RawInput } from './v2/pipeline-v2-session-input-effect'
import { pipelineV2Fingerprint } from '../../../shared/pipelines/v2/pipeline-v2-fingerprint'
import { preparePipelineStoreFile, restrictPipelineStoreSidecars } from './pipeline-store-file'
import { applyInternalPipelineV2 } from './pipeline-store-v2-command'
import Database from '../../sqlite/sync-database'
import {
  PipelineCreate,
  PipelineMutation,
  type PipelineRun,
  type PipelineStage
} from '../../../shared/pipelines/pipeline-contracts'
import { pipelineDigest } from './pipeline-digest'
export { pipelineDigest } from './pipeline-digest'
import { transitionPipeline } from './pipeline-state'
import { assemblePipelineContext } from './pipeline-context'
import { assertPipelineV2SchemaSupported, PipelineV2Journal } from './v2/pipeline-v2-journal'
import { PipelineV2Templates } from './v2/pipeline-v2-templates'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import { publishPipelineV2Change } from './v2/pipeline-v2-events'
import { PipelineV2OwnerRequests } from './v2/pipeline-v2-owner-requests'
import { PipelineEffectJournal } from './pipeline-effect-journal'
import { initializeLegacyPipelineSchema } from './pipeline-store-schema'
import type { PipelineV2OwnerHistory } from './v2/pipeline-v2-owner-history'

export class PipelineStore {
  readonly templatesV2: PipelineV2Templates
  readonly ownerRequestsV2: PipelineV2OwnerRequests
  readonly decisionsV2: PipelineV2OwnerHistory
  private readonly creations: PipelineCreationJournal<PipelineRun>
  private readonly v2Creations: PipelineCreationJournal<PipelineV2Run>
  private readonly db: Database.Database
  private readonly v2: PipelineV2Journal
  private readonly effects: PipelineEffectJournal

  constructor(
    file: string,
    private readonly publish?: (event: RuntimeClientEvent) => void
  ) {
    preparePipelineStoreFile(file)
    this.db = new Database(file)
    try {
      assertPipelineV2SchemaSupported(this.db)
    } catch (error) {
      this.db.close()
      throw error
    }
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec('SAVEPOINT pipeline_store_schema')
    try {
      initializeLegacyPipelineSchema(this.db)
      this.v2 = new PipelineV2Journal(this.db)
      this.decisionsV2 = this.v2.decisions
      this.templatesV2 = new PipelineV2Templates(this.db)
      this.ownerRequestsV2 = new PipelineV2OwnerRequests(this.db)
      this.effects = new PipelineEffectJournal(this.db)
      this.creations = new PipelineCreationJournal(
        this.db,
        'pipeline_creations',
        pipelineDigest,
        (id) => this.get(id)
      )
      this.v2Creations = new PipelineCreationJournal(
        this.db,
        'pipeline_creations_v2',
        pipelineV2Fingerprint,
        (id) => this.getV2(id),
        () => assertPipelineCreationCapacity(this.db)
      )
      this.db.exec('RELEASE pipeline_store_schema')
    } catch (error) {
      this.db.exec('ROLLBACK TO pipeline_store_schema')
      this.db.exec('RELEASE pipeline_store_schema')
      this.db.close()
      throw error
    }
    restrictPipelineStoreSidecars(file)
  }

  create(input: unknown): PipelineRun {
    const parsed = PipelineCreate.parse(input)
    return this.request(parsed.requestId, parsed, () => {
      const count = this.db
        .prepare(
          `SELECT
            (SELECT count(*) FROM pipeline_runs WHERE json_extract(data, '$.state') NOT IN ('ready_for_review', 'failed')) +
            (SELECT count(*) FROM pipeline_runs_v2 WHERE json_extract(data, '$.state') NOT IN ('completed', 'failed')) AS count`
        )
        .get()
      if (Number(count?.count) >= 50) {
        throw new Error('pipeline_active_run_limit')
      }
      const existing = this.db
        .prepare('SELECT id FROM pipeline_runs WHERE instance_id = ?')
        .get(parsed.workspace.instanceId)
      if (existing || this.v2.bound(parsed.workspace.instanceId)) {
        throw new Error('pipeline_workspace_already_bound')
      }
      const run: PipelineRun = {
        id: randomUUID(),
        workspace: parsed.workspace,
        profile: parsed.profile,
        definitionDigest: pipelineDigest(parsed.profile),
        provider: parsed.provider,
        checkSnapshot: parsed.checkSnapshot,
        baseCommit: parsed.baseCommit,
        task: parsed.task,
        revision: 0,
        state: parsed.waitForSetup ? 'waiting_setup' : 'running',
        ...(parsed.waitForSetup ? { setupHold: {} } : {}),
        stage: 'plan',
        fixCycles: 0,
        artifacts: []
      }
      this.db
        .prepare('INSERT INTO pipeline_runs (id, instance_id, data) VALUES (?, ?, ?)')
        .run(run.id, run.workspace.instanceId, JSON.stringify(run))
      return run
    })
  }

  get(id: string): PipelineRun {
    const row = this.db.prepare('SELECT data FROM pipeline_runs WHERE id = ?').get(id)
    if (!row || typeof row.data !== 'string') {
      throw new Error('pipeline_not_found')
    }
    return JSON.parse(row.data)
  }

  createV2(input: unknown) {
    const run = this.v2.create(input)
    publishPipelineV2Change(this.publish, run)
    return run
  }

  getV2(id: string) {
    return this.v2.get(id)
  }

  historyContext(id: string, selector: Parameters<typeof readPipelineV2HistoryContext>[2]) {
    return readPipelineV2HistoryContext(this, this.getV2(id), selector)
  }

  observeRawInput(
    binding: Parameters<typeof invalidatePipelineV2RawInput>[1],
    input: Parameters<typeof invalidatePipelineV2RawInput>[2]
  ): void {
    invalidatePipelineV2RawInput(this, binding, input)
  }

  hasV2(id: string): boolean {
    return this.v2.has(id)
  }

  listV2() {
    return this.v2.list()
  }
  pageV2(projectId: string, cursor: number, limit: number) {
    return this.v2.page(projectId, cursor, limit)
  }

  pendingV2() {
    return this.v2.list(true)
  }

  commandV2(id: string, input: unknown) {
    const run = this.v2.command(id, input)
    publishPipelineV2Change(this.publish, run)
    return run
  }

  internalV2(id: string, command: PipelineV2Command, requestId?: string): PipelineV2Run {
    return applyInternalPipelineV2(this, id, command, requestId)
  }

  receiptV2(id: string, requestId: string) {
    return this.v2.receipt(id, requestId)
  }

  requestRunV2(requestId: string) {
    return this.v2.requestRun(requestId)
  }

  eventsV2(id: string, cursor = 0, limit = 50) {
    return this.v2.events(id, cursor, limit)
  }

  list(): PipelineRun[] {
    return this.db
      .prepare('SELECT data FROM pipeline_runs ORDER BY rowid DESC LIMIT 50')
      .all()
      .map((row): PipelineRun => JSON.parse(String(row.data)))
  }

  reserveCreation(id: string, input: unknown, snapshot?: unknown) {
    return this.creations.reserve(id, input, snapshot)
  }

  creation(id: string, input: unknown) {
    return this.creations.creation(id, input)
  }

  creationSnapshot(id: string): unknown {
    return this.creations.snapshot(id)
  }

  completeCreation(id: string, runId: string): void {
    this.creations.complete(id, runId)
  }

  reserveCreationV2(id: string, input: unknown, snapshot?: unknown) {
    return this.v2Creations.reserve(id, input, snapshot)
  }

  creationV2(id: string, input: unknown) {
    return this.v2Creations.creation(id, input)
  }

  creationSnapshotV2(id: string): unknown {
    return this.v2Creations.snapshot(id)
  }

  completeCreationV2(id: string, runId: string): void {
    this.v2Creations.complete(id, runId)
  }

  pending(): PipelineRun[] {
    return this.db
      .prepare(
        "SELECT data FROM pipeline_runs WHERE json_extract(data, '$.state') NOT IN ('ready_for_review', 'failed') ORDER BY rowid"
      )
      .all()
      .map((row): PipelineRun => JSON.parse(String(row.data)))
  }

  command(id: string, input: unknown): PipelineRun {
    const parsed = PipelineMutation.parse(input)
    return this.request(parsed.requestId, { id, ...parsed }, () => {
      const run = this.get(id)
      if (run.revision !== parsed.expectedRevision) {
        throw new Error('pipeline_revision_conflict')
      }
      const next = transitionPipeline(run, parsed.command)
      next.revision++
      this.db
        .prepare('UPDATE pipeline_runs SET data = ? WHERE id = ?')
        .run(JSON.stringify(next), id)
      return next
    })
  }

  replay(id: string, input: unknown): PipelineRun | undefined {
    const parsed = PipelineMutation.parse(input)
    const row = this.db
      .prepare('SELECT digest, result FROM pipeline_requests WHERE id = ?')
      .get(parsed.requestId)
    if (!row) {
      return undefined
    }
    if (row.digest !== pipelineDigest({ id, ...parsed })) {
      throw new Error('pipeline_request_conflict')
    }
    return JSON.parse(String(row.result))
  }

  configureChecks(projectId: string, checks: unknown): void {
    this.db
      .prepare('INSERT OR REPLACE INTO pipeline_check_config (project_id, data) VALUES (?, ?)')
      .run(projectId, JSON.stringify(checks))
  }

  configuredChecks(projectId: string): unknown {
    const row = this.db
      .prepare('SELECT data FROM pipeline_check_config WHERE project_id = ?')
      .get(projectId)
    return row ? JSON.parse(String(row.data)) : []
  }

  context(id: string, stage: PipelineStage, artifactStage?: PipelineStage, artifactIndex?: number) {
    return assemblePipelineContext(this.get(id), stage, artifactStage, artifactIndex)
  }

  close(): void {
    this.db.close()
  }

  claimEffect(id: string): boolean {
    return this.effects.claim(id)
  }

  settleEffect(id: string, result: unknown): void {
    this.effects.settle(id, result)
  }

  completedCheckEffect(id: string): boolean {
    return this.effects.completedCheck(id)
  }
  launchReceiptV2(invocationId: string) {
    return this.effects.launchReceipt(invocationId)
  }

  private request(id: string, payload: unknown, apply: () => PipelineRun): PipelineRun {
    const digest = pipelineDigest(payload)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.db
        .prepare('SELECT digest, result FROM pipeline_requests WHERE id = ?')
        .get(id)
      let result: PipelineRun
      if (existing) {
        if (existing.digest !== digest) {
          throw new Error('pipeline_request_conflict')
        }
        result = JSON.parse(String(existing.result))
      } else {
        result = apply()
        this.db
          .prepare('INSERT INTO pipeline_requests (id, digest, result) VALUES (?, ?, ?)')
          .run(id, digest, JSON.stringify(result))
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
