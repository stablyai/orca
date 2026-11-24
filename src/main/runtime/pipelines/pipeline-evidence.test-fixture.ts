import type { PipelineStage } from '../../../shared/pipelines/pipeline-contracts'
import type { PipelineStageEvidence } from '../../../shared/pipelines/pipeline-stage-evidence'

export function stageEvidence(stage: PipelineStage, verdict = 'pass'): PipelineStageEvidence {
  switch (stage) {
    case 'plan':
      return {
        stage,
        criteria: ['No duplicate delivery'],
        steps: ['Implement a receipt check and regression']
      }
    case 'implement':
    case 'fix':
      return { stage, changes: ['Add duplicate delivery protection'] }
    case 'docs':
      return { stage, files: [], rationale: 'No user-facing behavior changed' }
    case 'review':
      return {
        stage,
        findings:
          verdict === 'changes_requested'
            ? [
                {
                  severity: 'important',
                  detail: 'Missing duplicate regression',
                  conditionToFix: 'Add a regression exercising duplicate delivery'
                }
              ]
            : []
      }
    case 'checks':
      return { stage, results: [{ id: 'unit', code: 0, timedOut: false, outputTruncated: false }] }
  }
}
