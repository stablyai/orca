import type { OrchestrationDb } from '../orchestration-db'

export function applySchemaMigrationV31(this: OrchestrationDb, current: number): void {
  if (current >= 31) {
    return
  }
  if (!this.hasColumn('worker_dispatches', 'worker_report_settled_at')) {
    this.db.exec('ALTER TABLE worker_dispatches ADD COLUMN worker_report_settled_at TEXT')
  }
  // v30 report stages survive message reset; abandoned reports need task or message evidence.
  this.db.exec(`
    UPDATE worker_dispatches
       SET worker_report_settled_at = updated_at
     WHERE (
       state IN ('succeeded', 'failed') AND stage = 'settled'
     ) OR EXISTS (
       SELECT 1
         FROM dispatch_contexts reported
         JOIN tasks reported_task ON reported_task.id = reported.task_id
        WHERE reported.id = worker_dispatches.dispatch_id
          AND worker_dispatches.state = 'abandoned'
          AND reported.status = 'failed'
          AND reported.last_failure IS NOT NULL
          AND reported_task.result IS reported.last_failure
     ) OR EXISTS (
       SELECT 1
         FROM dispatch_contexts reported
         JOIN messages report_message
           ON report_message.id = json_extract(reported.last_failure, '$.messageId')
        WHERE reported.id = worker_dispatches.dispatch_id
          AND reported.status = 'failed'
          AND json_valid(reported.last_failure)
          AND json_extract(reported.last_failure, '$.provenance') = 'worker_report'
          AND report_message.run_id = reported.run_id
          AND report_message.type = 'worker_done'
          AND json_valid(report_message.payload)
          AND json_extract(report_message.payload, '$.dispatchId') = reported.id
          AND json_extract(report_message.payload, '$.outcome') = 'failed'
          AND (
            json_type(report_message.payload, '$._orcaLifecycleRejection') IS NOT 'object'
            OR json_type(report_message.payload, '$._orcaLifecycleRejection.code') IS NOT 'text'
            OR json_type(report_message.payload, '$._orcaLifecycleRejection.reason') IS NOT 'text'
          )
     );
  `)
}
