import type {
  PipelineV2Definition,
  PipelineV2CompiledStage
} from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import {
  pipelineV2EvidenceExample,
  pipelineV2SubmitSchema
} from '../../../../shared/pipelines/v2/pipeline-v2-submit-contract'
import { assemblePipelineV2Visits, pipelineV2VisitSummary } from './pipeline-v2-visit-context'
import {
  assertPipelineV2ContextBudget as assertBounded,
  pipelineV2ContextPayloadLimit
} from './pipeline-v2-context-budget'

type ContextScope = {
  runId: string
  revision: number
  expectedInstanceId: string
  sourceRevision: string
  invocation?: {
    id: string
    dispatchId?: string
    inputRevision: number
    sourceRevision: string
    reviewCommit?: string
  }
}
export function pipelineV2MandatoryContext(
  definition: PipelineV2Definition,
  stage: PipelineV2CompiledStage,
  task: string,
  scope: ContextScope,
  options: { compactExample?: boolean } = {}
) {
  const kind = stage.kind === 'checks' ? 'checks' : stage.evidenceSchema
  return {
    ...scope,
    definitionDigest: definition.digest,
    stageId: stage.id,
    ...(stage.inputs.task ? { task } : {}),
    stage: {
      id: stage.id,
      title: stage.title,
      instructions: stage.instructions,
      expectedResult: stage.expectedResult,
      outcomes: stage.outcomes,
      evidenceSchema: kind
    },
    submit: {
      schema: pipelineV2SubmitSchema(stage),
      resultBudget: 12000,
      evidenceBudget: 4000,
      ...(options.compactExample
        ? { examplePins: 'Replace angle-bracket placeholders with the exact scope values above.' }
        : {}),
      example: {
        requestId: 'unique-request-id',
        expectedRevision: scope.revision,
        expectedInstanceId: options.compactExample
          ? '<expectedInstanceId>'
          : scope.expectedInstanceId,
        command: {
          kind: 'submit',
          invocationId: scope.invocation?.id ?? 'invocation-id',
          dispatchId: options.compactExample
            ? '<invocation.dispatchId>'
            : (scope.invocation?.dispatchId ?? 'dispatch-id'),
          inputRevision: scope.invocation?.inputRevision ?? scope.revision,
          sourceRevision: scope.sourceRevision,
          result: {
            status: 'result',
            outcomeId: stage.outcomes[0].id,
            summary: 'Explain the result',
            evidence: pipelineV2EvidenceExample(kind)
          }
        }
      }
    }
  }
}
function artifact(run: PipelineV2Run, id: string) {
  const candidate = run.candidates.find((value) => value.id === id)
  if (!candidate) {
    throw new Error('pipeline_artifact_not_found')
  }
  const { summary: _summary, ...result } = candidate.result
  return {
    id: candidate.id,
    visitId: candidate.visitId,
    invocationId: candidate.invocationId,
    dispatchId: candidate.dispatchId,
    sessionId: candidate.sessionId,
    inputRevision: candidate.inputRevision,
    discussionRevision: candidate.discussionRevision,
    digest: candidate.digest,
    sourceRevision: candidate.sourceRevision,
    summary: candidate.summary,
    result
  }
}
function contextBase(run: PipelineV2Run) {
  const stage = run.definition.stages.find((value) => value.id === run.stageId)!
  const invocation = run.invocations.find((value) => value.id === run.activeInvocationId)
  const visit = run.visits.find((value) => value.id === run.currentVisitId)!
  return {
    ...pipelineV2MandatoryContext(
      run.definition,
      stage,
      run.task,
      {
        runId: run.id,
        revision: run.revision,
        expectedInstanceId: run.workspace.instanceId,
        sourceRevision: run.sourceRevision,
        ...(invocation
          ? {
              invocation: {
                id: invocation.id,
                dispatchId: invocation.dispatchId,
                inputRevision: invocation.inputRevision,
                sourceRevision: invocation.sourceRevision,
                reviewCommit: invocation.reviewCommit
              }
            }
          : {})
      },
      { compactExample: true }
    ),
    visitId: visit.id,
    visit: pipelineV2VisitSummary(visit),
    ...(run.effectiveExecutors[stage.id] ? { executor: run.effectiveExecutors[stage.id] } : {}),
    ...((invocation?.message ?? visit.handoff?.comment)
      ? { ownerComment: invocation?.message ?? visit.handoff?.comment }
      : {})
  }
}
type Artifact = ReturnType<typeof artifact>
type Context = ReturnType<typeof contextBase> & {
  artifacts: Artifact[]
  truncated: boolean
  omittedArtifacts: string[]
  omittedCount: number
  artifactCursor: number
  readMore: string
}
type ArtifactContext = {
  runId: string
  revision: number
  artifacts: Artifact[]
  truncated: boolean
  omittedArtifacts: string[]
  cursor: number
  hasMore: boolean
}
type Selector = { artifactId: string } | { artifactCursor: number; limit?: number }
type VisitSelector = { visitId: string }
type VisitPageSelector = { visitCursor: number; limit?: number }
export function assemblePipelineV2Context(run: PipelineV2Run): Context
export function assemblePipelineV2Context(run: PipelineV2Run, selector: Selector): ArtifactContext
export function assemblePipelineV2Context(run: PipelineV2Run, selector: VisitSelector): Context
export function assemblePipelineV2Context(
  run: PipelineV2Run,
  selector: VisitPageSelector
): ReturnType<typeof assemblePipelineV2Visits>
export function assemblePipelineV2Context(
  run: PipelineV2Run,
  selector?: Selector | VisitSelector | VisitPageSelector
): Context | ArtifactContext | ReturnType<typeof assemblePipelineV2Visits> {
  if (selector) {
    if ('visitCursor' in selector) {
      return assemblePipelineV2Visits(run, selector)
    }
    if ('visitId' in selector) {
      const visit = run.visits.find((value) => value.id === selector.visitId)
      if (!visit) {
        throw new Error('pipeline_visit_missing')
      }
      return assemblePipelineV2Context({
        ...run,
        stageId: visit.stageId,
        currentVisitId: visit.id,
        activeInvocationId: visit.id === run.currentVisitId ? run.activeInvocationId : undefined
      })
    }
    if ('artifactId' in selector) {
      const result = {
        runId: run.id,
        revision: run.revision,
        artifacts: [artifact(run, selector.artifactId)],
        truncated: false,
        omittedArtifacts: [],
        cursor: 0,
        hasMore: false
      }
      assertBounded(result)
      return result
    }
    const cursor = selector.artifactCursor
    const limit = selector.limit ?? 50
    if (
      !Number.isInteger(cursor) ||
      cursor < 0 ||
      cursor > run.candidates.length ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50
    ) {
      throw new Error('pipeline_cursor_invalid')
    }
    const result: ArtifactContext = {
      runId: run.id,
      revision: run.revision,
      artifacts: [],
      truncated: false,
      omittedArtifacts: [],
      cursor,
      hasMore: cursor < run.candidates.length
    }
    for (const candidate of run.candidates.slice(cursor, cursor + limit)) {
      const next = artifact(run, candidate.id)
      if (
        JSON.stringify({ ...result, artifacts: [...result.artifacts, next] }).length >
        pipelineV2ContextPayloadLimit
      ) {
        break
      }
      result.artifacts.push(next)
      result.cursor++
    }
    result.hasMore = result.cursor < run.candidates.length
    result.truncated = result.hasMore
    assertBounded(result)
    return result
  }
  const stage = run.definition.stages.find((value) => value.id === run.stageId)!
  const visit = run.visits.find((value) => value.id === run.currentVisitId)!
  const plans = run.candidates.filter((value) => value.result.evidence?.stage === 'plan')
  const priorities = [
    ...(visit.handoff ? [visit.handoff.candidateId] : []),
    ...stage.inputs.stageIds.flatMap(
      (id) => run.visits.findLast((value) => value.stageId === id)?.candidateIds.slice(-1) ?? []
    ),
    ...(plans.at(-1) ? [plans.at(-1)!.id] : []),
    ...run.candidates
      .filter((value) => value.result.evidence?.stage === 'review')
      .map((value) => value.id)
      .toReversed(),
    ...run.candidates.map((value) => value.id).toReversed()
  ]
  const context: Context = {
    ...contextBase(run),
    artifacts: [],
    truncated: false,
    omittedArtifacts: [],
    omittedCount: 0,
    artifactCursor: 0,
    readMore:
      'Read a full artifact by artifactId, or page all artifacts with artifactCursor (limit <= 50).'
  }
  assertBounded(context)
  const ids = [...new Set(priorities)]
  const omitted: string[] = []
  for (const id of ids) {
    const next = artifact(run, id)
    const projected = {
      ...context,
      artifacts: [...context.artifacts, next],
      truncated: true,
      omittedCount: 256
    }
    if (JSON.stringify(projected).length <= pipelineV2ContextPayloadLimit) {
      context.artifacts.push(next)
    } else {
      omitted.push(id)
    }
  }
  context.omittedCount = omitted.length
  context.truncated = omitted.length > 0
  for (const id of omitted) {
    if (
      JSON.stringify({ ...context, omittedArtifacts: [...context.omittedArtifacts, id] }).length >
      pipelineV2ContextPayloadLimit
    ) {
      break
    }
    context.omittedArtifacts.push(id)
  }
  assertBounded(context)
  return context
}
