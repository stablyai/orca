import type { PipelineRun, PipelineStage } from '../../../shared/pipelines/pipeline-contracts'

export function assemblePipelineContext(
  run: PipelineRun,
  stage: PipelineStage,
  artifactStage?: PipelineStage,
  artifactIndex?: number
) {
  const latest = new Map<string, PipelineRun['artifacts'][number]>()
  for (const artifact of artifactIndex === undefined
    ? run.artifacts
    : run.artifacts.slice(artifactIndex, artifactIndex + 1)) {
    if (
      artifact.stage !== 'review' ||
      stage === 'fix' ||
      artifactStage ||
      artifactIndex !== undefined
    ) {
      latest.set(artifact.stage, artifact)
    }
  }
  const task = artifactStage || artifactIndex !== undefined ? '' : run.task
  const priority =
    stage === 'fix'
      ? ['review', 'checks', 'plan', 'docs', 'implement', 'fix']
      : ['plan', 'checks', 'docs', 'implement', 'fix']
  const selected = [...latest.values()]
    .filter((artifact) => !artifactStage || artifact.stage === artifactStage)
    .sort((a, b) => priority.indexOf(a.stage) - priority.indexOf(b.stage))
  const artifacts: (PipelineRun['artifacts'][number] & {
    truncated: boolean
    evidenceOmitted: boolean
  })[] = []
  const omittedStages: string[] = []
  let remaining =
    14500 -
    JSON.stringify({ runId: run.id, stage, revision: run.revision, task, artifacts, omittedStages })
      .length
  for (const artifact of selected) {
    const { body, evidence, ...metadata } = artifact
    const overhead = JSON.stringify({
      ...metadata,
      body: '',
      truncated: true,
      evidenceOmitted: true
    }).length
    if (remaining < overhead) {
      omittedStages.push(artifact.stage)
      continue
    }
    remaining -= overhead
    const evidenceSize = evidence ? JSON.stringify(evidence).length + 20 : 0
    const keptEvidence = evidenceSize <= remaining ? evidence : undefined
    if (keptEvidence) {
      remaining -= evidenceSize
    }
    let low = 0
    let high = body.length
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      if (JSON.stringify(body.slice(0, mid)).length - 2 <= remaining) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    const kept = body.slice(0, low)
    remaining -= JSON.stringify(kept).length - 2
    artifacts.push({
      ...metadata,
      body: kept,
      evidence: keptEvidence,
      truncated: kept.length !== body.length,
      evidenceOmitted: Boolean(evidence && !keptEvidence)
    })
  }
  return {
    runId: run.id,
    stage,
    revision: run.revision,
    task,
    artifacts,
    omittedStages,
    ...(stage === 'review' ? { reviewCommit: run.reviewCommit } : {})
  }
}
