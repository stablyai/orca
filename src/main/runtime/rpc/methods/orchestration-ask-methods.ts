import { defineMethod, type RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import { isGroupAddress } from '../../orchestration/groups'
import { AskParams } from './orchestration-schemas'
import { rejectFederatedExplicitTarget } from './orchestration-routing'
import { askRemoteRunHome } from './orchestration-ask-remote'

export const ORCHESTRATION_ASK_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.ask',
    params: AskParams,
    handler: async (
      params,
      { runtime, signal, orchestrationCapability, recordMutationReceipt }
    ) => {
      // Why: group addresses have no unambiguous first-answer authority.
      if (params.to && isGroupAddress(params.to)) {
        throw new Error(
          'ask does not support group addresses; use send for non-blocking fan-out questions'
        )
      }

      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      // Why: echoed on every return so a clamped caller reports the budget actually waited, not the one it asked for.
      const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
      const paneKey = runtime.getTerminalPaneKey(from) ?? undefined
      const remoteAttachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
      if (remoteAttachment) {
        rejectFederatedExplicitTarget(params)
        return askRemoteRunHome({
          params: { ...params, timeoutMs },
          runtime,
          signal,
          orchestrationCapability,
          recordMutationReceipt,
          from,
          paneKey: paneKey as string,
          dispatchId: remoteAttachment.dispatch_id,
          taskId: remoteAttachment.task_id
        })
      }
      const activeDispatch = db.getActiveDispatchForIdentity(from, paneKey)
      if (!activeDispatch) {
        throw new OrchestrationError(
          'dispatch_inactive',
          'ask requires an active supervised Dispatch.'
        )
      }
      if (activeDispatch.capability_hash) {
        const authority = db.verifyDispatchCapability({
          dispatchId: activeDispatch.id,
          capability: orchestrationCapability,
          paneKey,
          processIncarnation: runtime.getTerminalProcessIncarnation(from) ?? undefined
        })
        if (!authority.valid) {
          throw new OrchestrationError('dispatch_capability_invalid', authority.reason)
        }
      }
      const options =
        params.options
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []
      let question = params.resume ? db.getQuestion(params.resume) : undefined
      if (params.resume) {
        if (!question || question.dispatch_id !== activeDispatch.id) {
          throw new OrchestrationError(
            'question_not_found',
            `Question ${params.resume} does not belong to this active Dispatch.`
          )
        }
      } else {
        const run = db.getRun(activeDispatch.run_id)
        if (!run || run.legacy === 1) {
          throw new OrchestrationError(
            'run_not_found',
            `Run ${activeDispatch.run_id} was not found.`
          )
        }
        if (params.run && params.run !== run.id) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `Dispatch ${activeDispatch.id} belongs to Run ${run.id}, not ${params.run}.`
          )
        }
        if (params.to && params.to !== `run:${run.id}` && params.to !== run.coordinator_handle) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `ask from Dispatch ${activeDispatch.id} must target its owning Run ${run.id}.`
          )
        }
        const created = db.createQuestion({
          runId: run.id,
          dispatchId: activeDispatch.id,
          askerHandle: from,
          question: params.question as string,
          options
        })
        question = created.question
        runtime.notifyMessageArrived(`run:${run.id}`, created.message.type)
      }

      const questionId = question.message_id
      recordMutationReceipt?.({
        accepted: true,
        answer: null,
        messageId: questionId,
        threadId: questionId,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      })
      const deadline = Date.now() + timeoutMs
      while (true) {
        const current = db.getQuestion(questionId)
        if (!current || current.status === 'closed') {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Question ${questionId} closed because its Dispatch is inactive.`
          )
        }
        if (current.status === 'answered') {
          return {
            answer: current.answer_body,
            messageId: questionId,
            answerMessageId: current.answer_message_id,
            threadId: questionId,
            timedOut: false,
            cancelled: false,
            connectionLost: false,
            timeoutMs
          }
        }
        if (signal?.aborted) {
          return {
            answer: null,
            messageId: questionId,
            threadId: questionId,
            timedOut: false,
            cancelled: true,
            connectionLost: true,
            timeoutMs
          }
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          return {
            answer: null,
            messageId: questionId,
            threadId: questionId,
            timedOut: true,
            cancelled: false,
            connectionLost: false,
            timeoutMs
          }
        }
        await runtime.waitForMessage(`dispatch:${activeDispatch.id}`, {
          timeoutMs: remainingMs,
          signal
        })
      }
    }
  })
]
