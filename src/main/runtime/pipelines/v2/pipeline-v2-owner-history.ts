import type Database from '../../../sqlite/sync-database'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2Mutation } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import { PipelineV2OwnerDecisionRecord } from '../../../../shared/pipelines/v2/pipeline-v2-owner-history'
import { pipelineV2Fingerprint } from '../../../../shared/pipelines/v2/pipeline-v2-fingerprint'

export class PipelineV2OwnerHistory {
  constructor(private readonly db: Database.Database) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS pipeline_owner_decisions_v2 (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, visit_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE (run_id,visit_id))'
    )
    db.prepare('INSERT OR IGNORE INTO pipeline_schema (component,version) VALUES (?,?)').run(
      'pipelines-v2-decisions',
      1
    )
  }
  record(before: PipelineV2Run, mutation: PipelineV2Mutation, after: PipelineV2Run): void {
    const command = mutation.command
    if (command.kind !== 'decide') {
      return
    }
    const candidate = before.candidates.find((value) => value.id === command.candidateId)!
    const stage = before.definition.stages.find((value) => value.id === before.stageId)!
    const record = PipelineV2OwnerDecisionRecord.parse({
      id: `owner-decision:${pipelineV2Fingerprint(mutation.requestId)}`,
      runId: before.id,
      requestId: mutation.requestId,
      workspaceInstanceId: before.workspace.instanceId,
      visitId: command.visitId,
      stageId: stage.id,
      action: command.action,
      proposedOutcomeId: command.proposedOutcomeId,
      ...(command.action === 'accept' ? { outcomeId: command.proposedOutcomeId } : {}),
      target:
        command.action === 'accept'
          ? command.proposedTarget
          : { kind: 'stage', stageId: stage.ownerGate.reworkTargetStageId },
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      sourceRevision: candidate.sourceRevision,
      sessionId: candidate.sessionId,
      inputRevision: candidate.inputRevision,
      discussionRevision: candidate.discussionRevision,
      executor: before.effectiveExecutors[stage.id],
      comment: command.comment,
      revision: after.revision,
      sequence: after.eventSequence,
      createdAt: Date.now()
    })
    this.db
      .prepare('INSERT INTO pipeline_owner_decisions_v2 (id,run_id,visit_id,data) VALUES (?,?,?,?)')
      .run(record.id, record.runId, record.visitId, JSON.stringify(record))
  }
  forVisit(runId: string, visitId: string): PipelineV2OwnerDecisionRecord | null {
    const row = this.db
      .prepare('SELECT data FROM pipeline_owner_decisions_v2 WHERE run_id=? AND visit_id=?')
      .get(runId, visitId)
    return row ? PipelineV2OwnerDecisionRecord.parse(JSON.parse(String(row.data))) : null
  }
  artifact(runId: string, id: string): PipelineV2OwnerDecisionRecord | null {
    const row = this.db
      .prepare('SELECT data FROM pipeline_owner_decisions_v2 WHERE run_id=? AND id=?')
      .get(runId, id)
    return row ? PipelineV2OwnerDecisionRecord.parse(JSON.parse(String(row.data))) : null
  }
}
