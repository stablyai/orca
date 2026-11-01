import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { clampOrchestrationAskTimeoutMs } from '../../../../../../shared/orchestration-ask-timeout'
import { isGroupAddress } from '../../../../orchestration/groups'
import { dispatchReportMailbox } from '../../../../orchestration/dispatch-report-mailbox'
import { AskParams } from '../schemas'
import { rejectFederatedExplicitTarget } from '../routing'
import { askRemoteRunHome } from './ask-remote'
import {
  mailboxAddressOf,
  runCoordinatorKey
} from '../../../../orchestration/orchestration-caller-identity'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { assertLifecycleCallerIsNotAnotherParty } from './lifecycle-caller-fence'
import { assertWorkerCanReport } from '../../../../orchestration/worker-report-admission'
import {
  askedQuestionReceipt,
  waitForQuestionAnswer
} from '../../../../orchestration/question-answer-delivery'

export const ORCHESTRATION_ASK_METHODS = [
  defineMethod({
    name: 'orchestration.ask',
    permission: 'workspace',
    params: AskParams,
    handler: async (
      params,
      {
        runtime,
        signal,
        recordMutationReceipt,
        orchestrationCaller,
        orchestrationCompatibilityEvidence
      }
    ) => {
      // Group addresses cannot select an unambiguous first answerer.
      if (params.to && isGroupAddress(params.to)) {
        throw new OrchestrationError(
          'invalid_argument',
          'ask does not support group addresses; ask your owning run:<id>, or use send for a non-blocking fan-out within your Run.'
        )
      }

      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      // Echo the clamped budget on every return so callers report time actually waited.
      const timeoutMs = clampOrchestrationAskTimeoutMs(params.timeoutMs)
      const paneKey = runtime.getTerminalPaneKey(from) ?? undefined
      if (!orchestrationCaller) {
        assertLifecycleCallerIsNotAnotherParty(runtime, {
          from,
          fromPaneKey: paneKey,
          evidence: orchestrationCompatibilityEvidence
        })
      }
      const remoteAttachment = paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
      if (remoteAttachment && paneKey) {
        rejectFederatedExplicitTarget(params, remoteAttachment.home_run_id)
        return askRemoteRunHome({
          params: { ...params, timeoutMs },
          runtime,
          signal,
          recordMutationReceipt,
          from,
          paneKey,
          dispatchId: remoteAttachment.dispatch_id,
          taskId: remoteAttachment.task_id,
          workerState: remoteAttachment.state
        })
      }
      const activeDispatch = db.getActiveDispatchForIdentity(from, paneKey)
      if (!activeDispatch) {
        throw new OrchestrationError(
          'dispatch_inactive',
          'ask requires an active supervised Dispatch.'
        )
      }
      assertWorkerCanReport({
        dispatchId: activeDispatch.id,
        from,
        workerState: db.getWorkerDispatch(activeDispatch.id)?.state,
        processCurrent:
          !activeDispatch.process_incarnation ||
          db.isDispatchProcessCurrent({
            dispatchId: activeDispatch.id,
            paneKey: paneKey ?? null,
            processIncarnation: runtime.getTerminalProcessIncarnation(from)
          })
      })
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
        const reportTo = dispatchReportMailbox(db, activeDispatch)
        if (
          params.to &&
          params.to !== `run:${run.id}` &&
          params.to !== reportTo &&
          resolveOrchestrationParty(params.to, db).address !==
            mailboxAddressOf(runCoordinatorKey(run))
        ) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `ask from Dispatch ${activeDispatch.id} must target its owning Run ${run.id}.`
          )
        }
        // An explicit Run or coordinator target still reaches the Run; otherwise the asker's creator.
        const to = params.to && params.to !== reportTo ? `run:${run.id}` : reportTo
        const created = db.createQuestion({
          runId: run.id,
          dispatchId: activeDispatch.id,
          askerHandle: from,
          question: params.question as string,
          options,
          to
        })
        question = created.question
        runtime.notifyMessageArrived(to, created.message.type)
      }

      const questionId = question.message_id
      if (!params.resume && params.wait === false) {
        return askedQuestionReceipt(questionId, recordMutationReceipt)
      }
      return waitForQuestionAnswer({
        runtime,
        questionId,
        readQuestion: () => db.getQuestion(questionId),
        closedMessage: `Question ${questionId} closed because its Dispatch is inactive.`,
        timeoutMs,
        signal,
        recordMutationReceipt
      })
    }
  })
]
