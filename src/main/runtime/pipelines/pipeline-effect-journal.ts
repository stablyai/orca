import type Database from '../../sqlite/sync-database'
import { PipelineV2InvocationReceipt } from '../../../shared/pipelines/v2/pipeline-v2-results'

export class PipelineEffectJournal {
  constructor(private readonly db: Database.Database) {}
  claim(id: string): boolean {
    return (
      this.db.prepare('INSERT OR IGNORE INTO pipeline_effects (id) VALUES (?)').run(id).changes ===
      1
    )
  }
  settle(id: string, result: unknown): void {
    this.db
      .prepare('UPDATE pipeline_effects SET result = ? WHERE id = ?')
      .run(JSON.stringify(result), id)
  }
  completedCheck(id: string): boolean {
    const row = this.db.prepare('SELECT result FROM pipeline_effects WHERE id = ?').get(id)
    if (typeof row?.result !== 'string') {
      return false
    }
    const result: { processComplete?: boolean } = JSON.parse(row.result)
    return result.processComplete === true
  }
  launchReceipt(invocationId: string) {
    const row = this.db
      .prepare('SELECT result FROM pipeline_effects WHERE id=?')
      .get(`pipeline-v2:${invocationId}`)
    return typeof row?.result === 'string'
      ? PipelineV2InvocationReceipt.parse(JSON.parse(row.result))
      : undefined
  }
}
