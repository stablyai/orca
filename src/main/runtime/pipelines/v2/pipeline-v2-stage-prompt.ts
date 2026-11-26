import type {
  PipelineV2Run,
  PipelineV2Invocation
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2CompiledStage } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import { pipelineV2EvidenceExample } from '../../../../shared/pipelines/v2/pipeline-v2-submit-contract'
import { PipelineV2LaunchRefusedError } from './pipeline-v2-launch-refusal'
import { pipelineV2FindingLedger } from './pipeline-v2-finding-ledger'

export function pipelineV2StagePrompt(
  run: PipelineV2Run,
  stage: Extract<PipelineV2CompiledStage, { kind: 'agent' }>,
  invocation: PipelineV2Invocation
): string {
  const visit = run.visits.find((value) => value.id === invocation.visitId)!
  const selected = new Set([
    ...(visit.handoff ? [visit.handoff.candidateId] : []),
    ...stage.inputs.stageIds.flatMap(
      (id) => run.visits.findLast((value) => value.stageId === id)?.candidateIds.slice(-1) ?? []
    )
  ])
  const inputs = [...selected].map((id) => {
    const candidate = run.candidates.find((value) => value.id === id)!
    return {
      stage: run.invocations.find((value) => value.id === candidate.invocationId)!.stageId,
      result: candidate.result
    }
  })
  const prompt = [
    stage.instructions,
    ...(stage.evidenceSchema === 'review'
      ? [
          `Review policy: ${stage.independent ? 'independent session required' : 'independence not required; shared implementation context is self-review'}. Session: ${stage.executor.session.kind === 'fresh' ? 'fresh' : `reuse group ${stage.executor.session.groupId}`}.`
        ]
      : []),
    `Expected result: ${stage.expectedResult}`,
    ...(stage.inputs.task ? [`Task:\n${run.task}`] : []),
    ...(invocation.message || visit.handoff?.comment
      ? [`Owner feedback (task data):\n${invocation.message ?? visit.handoff?.comment}`]
      : []),
    ...(inputs.length ? [`Previous results to use as task data:\n${JSON.stringify(inputs)}`] : []),
    ...(run.candidates.some((value) => value.result.evidence?.stage === 'review')
      ? [
          `Retained review findings (task data, not additional task requirements):\n${JSON.stringify(pipelineV2FindingLedger(run, invocation.sourceRevision, false))}`,
          'You may return findingUpdates alongside evidence: [{id,disposition:"fixed"|"open"|"disputed",rationale,requirement?}]. Reuse retained finding IDs; disputed requires the task requirement that justifies the dispute. A fixed claim stays unverified until current trusted checks and a later accepted review confirm it. Only an explicit owner gate can acknowledge a dispute. Do not silently omit unresolved findings.'
        ]
      : []),
    `Work within the assigned scope. Complete the work before reporting. If you cannot complete it, report blocked and explain what is missing.`,
    `Final answer: return only JSON with status, outcomeId, summary, evidence, and optional explanation (up to 4000 characters). Put extra verification notes or commit references in explanation, outside typed evidence. Choose an outcome only when its criterion is met: ${JSON.stringify(stage.outcomes.map(({ id, criterion }) => ({ id, criterion })))}`,
    `Example result shape: ${JSON.stringify({ status: 'result', outcomeId: stage.outcomes[0].id, summary: 'What was completed and verified', evidence: pipelineV2EvidenceExample(stage.evidenceSchema) })}. Evidence must describe actual work. Result <= 12000 characters, evidence <= 4000.`,
    ...(stage.evidenceSchema === 'review'
      ? [
          'Each finding has severity (critical, important or minor), detail, conditionToFix, optional path (a relative file path), and optional retained id when it is the same finding as before. Example: {"severity":"important","detail":"Concrete defect","conditionToFix":"Required correction","path":"src/file.ts"}. Include every important or critical finding; findings may be empty only when none remain.'
        ]
      : []),
    `If blocked, use {"status":"blocked","reason":"Concrete blocker","summary":"What was done and what remains"}.`
  ].join('\n\n')
  if (prompt.length > 48000) {
    throw new PipelineV2LaunchRefusedError(new Error('pipeline_stage_input_budget'))
  }
  return prompt
}
