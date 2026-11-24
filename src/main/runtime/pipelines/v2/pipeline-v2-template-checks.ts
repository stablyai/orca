import type Database from '../../../sqlite/sync-database'
import { z } from 'zod'
import { PipelineCheck } from '../../../../shared/pipelines/pipeline-contracts'
import type { PipelineV2Definition } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'

export function requirePipelineV2ProjectChecks(
  db: Database.Database,
  definition: PipelineV2Definition
): void {
  const config = db
    .prepare('SELECT data FROM pipeline_check_config WHERE project_id=?')
    .get(definition.projectId)
  const checks = z
    .array(PipelineCheck)
    .max(16)
    .parse(config ? JSON.parse(String(config.data)) : [])
  if (
    definition.stages.some(
      (stage) =>
        stage.kind === 'checks' &&
        stage.executor.checkIds.some((id) => !checks.some((check) => check.id === id))
    )
  ) {
    throw new Error('pipeline_project_checks_unconfigured')
  }
}
