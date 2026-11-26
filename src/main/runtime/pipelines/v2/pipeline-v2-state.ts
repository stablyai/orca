import type { PipelineV2Mutation } from '../../../../shared/pipelines/v2/pipeline-v2-mutations'
import type { PipelineV2Run } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { decidePipelineV2Candidate, extendPipelineV2Budget } from './pipeline-v2-decisions'
import { evaluatePipelineV2Completion } from './pipeline-v2-completion'
import { currentPipelineV2Visit, followPipelineV2Target } from './pipeline-v2-routing'
import { reconcilePipelineV2Invocation, retryPipelineV2Visit } from './pipeline-v2-reconciled-state'
import { retainPipelineV2ResponseObservation } from './pipeline-v2-response-observations'
import {
  bindPipelineV2Invocation,
  reservePipelineV2Invocation,
  settlePipelineV2Invocation,
  submitPipelineV2Invocation
} from './pipeline-v2-invocations'

export function transitionPipelineV2(
  previous: PipelineV2Run,
  mutation: PipelineV2Mutation
): PipelineV2Run {
  const run = structuredClone(previous)
  const command = mutation.command
  switch (command.kind) {
    case 'reconcile':
      reconcilePipelineV2Invocation(run, command.invocationId, command.response)
      break
    case 'retry':
      retryPipelineV2Visit(run, command.sourceRevision)
      break
    case 'revalidate': {
      const stage = run.definition.stages.find((value) => value.id === run.stageId)!
      if (
        stage.kind === 'checks' &&
        run.pendingDecision &&
        !run.activeInvocationId &&
        ['waiting_owner', 'paused'].includes(run.state) &&
        run.waitReason === 'owner_gate' &&
        command.sourceRevision !== run.sourceRevision
      ) {
        const pin = run.pendingDecision
        currentPipelineV2Visit(run).state = 'interrupted'
        delete run.pendingDecision
        delete run.waitReason
        delete run.reason
        run.sourceRevision = command.sourceRevision
        followPipelineV2Target(
          run,
          { kind: 'stage', stageId: stage.id },
          { fromVisitId: pin.visitId, candidateId: pin.candidateId }
        )
        break
      }
      const pendingFinish =
        run.state === 'running' &&
        run.waitReason === 'completion' &&
        run.pendingTransition?.target.kind === 'finish'
      if (
        run.definition.completionPolicy.kind !== 'reviewed_source' ||
        (!pendingFinish && run.state !== 'completed') ||
        run.activeInvocationId ||
        run.pendingDecision
      ) {
        throw new Error('pipeline_completion_conflict')
      }
      const completion = evaluatePipelineV2Completion(run, command.sourceRevision)
      run.sourceRevision = command.sourceRevision
      if (completion.ready) {
        delete run.pendingTransition
        delete run.waitReason
        delete run.reason
        run.state = 'completed'
      } else if (completion.repairEntryStageId) {
        const handoff = run.pendingTransition?.handoff
        followPipelineV2Target(
          run,
          { kind: 'stage', stageId: completion.repairEntryStageId },
          handoff
        )
        run.reason = completion.reason
      }
      break
    }
    case 'reserve':
      reservePipelineV2Invocation(run, command)
      break
    case 'bind':
      bindPipelineV2Invocation(run, command)
      break
    case 'submit':
      submitPipelineV2Invocation(run, command)
      break
    case 'settle':
      settlePipelineV2Invocation(run, command)
      break
    case 'decide':
      decidePipelineV2Candidate(run, command)
      break
    case 'extend_budget':
      extendPipelineV2Budget(run, command)
      break
    case 'pause':
      if (!['running', 'waiting_setup', 'waiting_owner'].includes(run.state)) {
        throw new Error('pipeline_not_running')
      }
      run.state = 'paused'
      if (command.reason) {
        run.reason = command.reason
      }
      break
    case 'resume':
      if (!run.definitionEnabled) {
        throw new Error('pipeline_definition_disabled')
      }
      if (run.state === 'waiting_owner') {
        throw new Error('pipeline_owner_decision_required')
      }
      if (run.state !== 'paused' || run.setupHold) {
        throw new Error('pipeline_reconciliation_required')
      }
      run.state =
        run.pendingDecision || (run.waitReason && run.waitReason !== 'completion')
          ? 'waiting_owner'
          : 'running'
      if (!run.waitReason) {
        delete run.reason
      }
      break
    case 'definition_disabled':
      run.definitionEnabled = false
      if (!['completed', 'failed'].includes(run.state)) {
        run.state = 'paused'
      }
      run.reason = 'Template version disabled'
      break
    case 'definition_enabled':
      run.definitionEnabled = true
      break
    case 'observe_response': {
      retainPipelineV2ResponseObservation(run, command.invocationId, command.observation)
      break
    }
    case 'uncertain':
      run.state = 'reconciliation_required'
      run.reason = command.reason
      if (run.activeInvocationId) {
        const invocation = run.invocations.find((value) => value.id === run.activeInvocationId)!
        invocation.state = 'uncertain'
      }
      break
    case 'launch_refused':
    case 'interrupted': {
      const invocation = run.invocations.find((value) => value.id === command.invocationId)
      if (!invocation || run.activeInvocationId !== invocation.id) {
        throw new Error('pipeline_invocation_conflict')
      }
      if (
        command.kind === 'launch_refused' &&
        (invocation.state !== 'reserved' || invocation.dispatchId || invocation.session)
      ) {
        throw new Error('pipeline_invocation_conflict')
      }
      invocation.state = 'settled'
      delete run.activeInvocationId
      const visit = run.visits.find((value) => value.id === run.currentVisitId)!
      visit.state = 'interrupted'
      if (run.state !== 'paused') {
        run.state = 'waiting_owner'
      }
      run.waitReason =
        run.pendingDecision && run.unverifiedSessionInput ? 'session_sync' : 'interrupted'
      run.reason =
        command.kind === 'launch_refused'
          ? command.reason
          : (command.reason ?? 'Worker settled without stage evidence; inspect before recovery')
      break
    }
    case 'setup_ready':
      if (!run.setupHold) {
        throw new Error('pipeline_setup_conflict')
      }
      delete run.setupHold
      if (run.state === 'waiting_setup') {
        run.state = 'running'
      }
      break
    case 'setup_wait':
      if (!run.setupHold) {
        throw new Error('pipeline_setup_conflict')
      }
      run.setupHold = command.terminalHandle ? { terminalHandle: command.terminalHandle } : {}
      break
    case 'invalidate_candidate': {
      const candidate = run.candidates.find(
        (value) => value.id === run.pendingDecision?.candidateId
      )
      if (!candidate || candidate.sessionId !== command.sessionId) {
        throw new Error('pipeline_session_conflict')
      }
      run.unverifiedSessionInput = { sessionId: command.sessionId, receiptId: command.receiptId }
      run.waitReason = 'session_sync'
      break
    }
  }
  return run
}
