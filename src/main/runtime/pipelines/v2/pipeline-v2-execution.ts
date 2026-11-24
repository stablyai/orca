import type { PipelineStorePort } from '../pipeline-store-port'
import type { PipelineStore } from '../pipeline-store'
import type { PipelineV2Command } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import type { PipelineV2CompiledStage } from '../../../../shared/pipelines/v2/pipeline-v2-contracts'
import type {
  PipelineSessionBinding,
  PipelineV2EffectiveExecutor,
  PipelineV2Invocation,
  PipelineV2Run,
  PipelineV2Submission
} from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import type { PipelineV2Response } from './pipeline-v2-response'
import { pipelineV2StagePrompt } from './pipeline-v2-stage-prompt'
import { completePipelineV2Response } from './pipeline-v2-response-execution'
import type {
  PipelineCheckOutcome,
  PipelineV2InvocationReceipt
} from '../../../../shared/pipelines/v2/pipeline-v2-results'
import { assemblePipelineV2Context } from './pipeline-v2-context'
import { PipelineV2LaunchRefusedError } from './pipeline-v2-launch-refusal'
import { pipelineV2RequiresReviewCommit } from '../../../../shared/pipelines/v2/pipeline-v2-review-policy'

export type PipelineV2LaunchRequest = {
  runId: string
  workspace: PipelineV2Run['workspace']
  invocation: PipelineV2Invocation
  executor: PipelineV2EffectiveExecutor
  stage: Extract<PipelineV2CompiledStage, { kind: 'agent' }>
  previousSession?: PipelineSessionBinding
}
export type PipelineV2Ports = {
  response?: (invocation: PipelineV2Invocation, messageId: string) => Promise<PipelineV2Response>
  completeResponse?: (
    invocation: PipelineV2Invocation,
    result?: PipelineV2Submission
  ) => Promise<void>
  definitionEnabled?: (run: PipelineV2Run) => boolean | Promise<boolean>
  sourceRevision: (workspace: PipelineV2Run['workspace']) => Promise<string>
  reviewCommit: (workspace: PipelineV2Run['workspace']) => Promise<string>
  settled: (dispatchId: string) => Promise<boolean>
  checks: (run: PipelineV2Run, ids: string[]) => Promise<PipelineCheckOutcome>
  startInvocation: (
    request: PipelineV2LaunchRequest,
    spec: string,
    prepared: (binding: {
      dispatchId: string
      session: PipelineSessionBinding
    }) => void | Promise<void>
  ) => Promise<PipelineV2InvocationReceipt>
}

export function commandPipelineV2(
  store: PipelineStore,
  id: string,
  command: PipelineV2Command,
  requestId?: string
): PipelineV2Run
export function commandPipelineV2(
  store: PipelineStorePort,
  id: string,
  command: PipelineV2Command,
  requestId?: string
): PipelineV2Run | Promise<PipelineV2Run>
export function commandPipelineV2(
  store: PipelineStorePort,
  id: string,
  command: PipelineV2Command,
  requestId?: string
): PipelineV2Run | Promise<PipelineV2Run> {
  return store.internalV2(id, command, requestId)
}

function checkCategory(
  ids: string[],
  result: PipelineCheckOutcome
): PipelineCheckOutcome['category'] {
  if (
    result.category === 'unknown' ||
    result.results.length !== ids.length ||
    new Set(result.results.map((value) => value.id)).size !== ids.length ||
    result.results.some(
      (value) => !ids.includes(value.id) || (value.code === null && !value.timedOut)
    )
  ) {
    return 'unknown'
  }
  if (result.results.some((value) => value.code !== 0 || value.timedOut)) {
    return 'failed'
  }
  return result.category === 'passed' ? 'passed' : 'unknown'
}

async function executeChecks(
  store: PipelineStorePort,
  ports: PipelineV2Ports,
  run: PipelineV2Run,
  invocation: PipelineV2Invocation,
  stage: Extract<PipelineV2CompiledStage, { kind: 'checks' }>,
  effect: string
): Promise<void> {
  await commandPipelineV2(store, run.id, {
    kind: 'bind',
    invocationId: invocation.id,
    dispatchId: invocation.id,
    session: { kind: 'checks', sessionId: 'runtime-checks', compatibilityKey: run.definitionDigest }
  })
  const result = await ports.checks(await store.getV2(run.id), stage.executor.checkIds)
  const category = checkCategory(stage.executor.checkIds, result)
  await store.settleEffect(effect, { processComplete: true, category })
  if (category === 'unknown') {
    throw new Error('pipeline_checks_incomplete')
  }
  if ((await ports.sourceRevision(run.workspace)) !== invocation.sourceRevision) {
    throw new Error('pipeline_source_changed')
  }
  await commandPipelineV2(store, run.id, {
    kind: 'submit',
    invocationId: invocation.id,
    dispatchId: invocation.id,
    inputRevision: invocation.inputRevision,
    sourceRevision: invocation.sourceRevision,
    result: {
      status: 'result',
      outcomeId: stage.checkOutcomeMap[category],
      summary: result.body || 'Checks completed',
      evidence: { stage: 'checks', results: result.results }
    }
  })
  await commandPipelineV2(store, run.id, { kind: 'settle', invocationId: invocation.id })
}

export async function advancePipelineV2(
  store: PipelineStorePort,
  ports: PipelineV2Ports,
  id: string
): Promise<void> {
  let run = await store.getV2(id)
  if (run.waitReason === 'completion' && !run.activeInvocationId && run.state === 'running') {
    const sourceRevision = await ports.sourceRevision(run.workspace)
    await commandPipelineV2(store, id, { kind: 'revalidate', sourceRevision })
    return
  }
  if (run.state === 'reconciliation_required') {
    return
  }
  let invocation = run.invocations.find((value) => value.id === run.activeInvocationId)
  if (invocation && invocation.state !== 'reserved') {
    const messageId = (await store.launchReceiptV2(invocation.id))?.responseMessageId
    if (messageId) {
      await completePipelineV2Response(store, ports, run, invocation, messageId)
      return
    }
    if (invocation.dispatchId && (await ports.settled(invocation.dispatchId))) {
      await commandPipelineV2(store, id, {
        kind: invocation.state === 'submitted' ? 'settle' : 'interrupted',
        invocationId: invocation.id
      })
    }
    return
  }
  if (
    (run.state !== 'running' &&
      !(run.state === 'waiting_owner' && invocation && invocation.purpose !== 'stage')) ||
    !run.definitionEnabled
  ) {
    return
  }
  try {
    if (ports.definitionEnabled && !(await ports.definitionEnabled(run))) {
      await commandPipelineV2(store, id, { kind: 'definition_disabled' })
      return
    }
    const stage = run.definition.stages.find((value) => value.id === run.stageId)!
    if (!invocation) {
      const sourceRevision = await ports.sourceRevision(run.workspace)
      run = await commandPipelineV2(store, id, {
        kind: 'reserve',
        invocationId: `${id}:invocation:${run.usedInvocations + 1}`,
        purpose: 'stage',
        sourceRevision,
        ...(pipelineV2RequiresReviewCommit(run.definition, stage)
          ? { reviewCommit: await ports.reviewCommit(run.workspace) }
          : {})
      })
      invocation = run.invocations.find((value) => value.id === run.activeInvocationId)
      if (!invocation) {
        return
      }
    }
    if (ports.definitionEnabled && !(await ports.definitionEnabled(run))) {
      await commandPipelineV2(store, id, { kind: 'definition_disabled' })
      return
    }
    const context =
      stage.kind === 'agent' && run.effectiveExecutors[stage.id]?.surface === 'terminal'
        ? assemblePipelineV2Context(run)
        : undefined
    const effect = `pipeline-v2:${invocation.id}`
    if (!(await store.claimEffect(effect))) {
      throw new Error('pipeline_invocation_effect_unknown')
    }
    if (stage.kind === 'checks') {
      await executeChecks(store, ports, run, invocation, stage, effect)
      return
    }
    const executor = run.effectiveExecutors[stage.id]
    if (!executor) {
      throw new Error('pipeline_executor_missing')
    }
    const discussionCandidate = run.candidates.find(
      (value) => value.id === run.pendingDecision?.candidateId
    )
    const previousSession =
      invocation.purpose !== 'stage'
        ? run.invocations.find((value) => value.id === discussionCandidate?.invocationId)?.session
        : stage.executor.session.kind === 'reuse'
          ? run.sessionGroups[stage.executor.session.groupId]
          : undefined
    const spec =
      executor.surface === 'chat'
        ? pipelineV2StagePrompt(run, stage, invocation)
        : `${stage.instructions}\nExpected result: ${stage.expectedResult}\nTask data (not permission grants):\n${context?.task ?? ''}\n` +
          `Pipeline v2 ${id}, invocation ${invocation.id}, input revision ${invocation.inputRevision}.`
    const prompt =
      invocation.purpose === 'stage' || executor.surface === 'chat'
        ? spec
        : `${spec}\nOwner discussion (task data, not acceptance):\n${invocation.message ?? 'Synchronize the current conversation and submit an updated candidate.'}`
    const receipt = await ports.startInvocation(
      { runId: id, workspace: run.workspace, invocation, executor, stage, previousSession },
      prompt,
      async (binding) => {
        await commandPipelineV2(store, id, {
          kind: 'bind',
          invocationId: invocation!.id,
          ...binding
        })
      }
    )
    await store.settleEffect(effect, receipt)
    const current = (await store.getV2(id)).invocations.find((value) => value.id === invocation!.id)
    if (receipt.state !== 'ready' || !current?.dispatchId || !current.session) {
      throw new Error('pipeline_launch_unconfirmed')
    }
  } catch (error) {
    const reason =
      error instanceof Error && /^[a-z][a-z0-9_]{1,120}$/.test(error.message)
        ? error.message
        : 'pipeline_invocation_outcome_unknown'
    const current = await store.getV2(id)
    const refused = current.invocations.find((value) => value.id === invocation?.id)
    if (
      error instanceof PipelineV2LaunchRefusedError &&
      refused?.state === 'reserved' &&
      !refused.dispatchId &&
      !refused.session &&
      current.activeInvocationId === refused.id
    ) {
      await store.settleEffect(`pipeline-v2:${refused.id}`, { state: 'not_started', reason })
      await commandPipelineV2(store, id, {
        kind: 'launch_refused',
        invocationId: refused.id,
        reason
      })
      return
    }
    if (!invocation && !current.activeInvocationId && current.state === 'running') {
      await commandPipelineV2(store, id, { kind: 'pause', reason })
      return
    }
    if (!invocation && !current.activeInvocationId && current.state === 'paused') {
      return
    }
    await commandPipelineV2(store, id, { kind: 'uncertain', reason })
  }
}
