import { assertSessionLinkMailBoundary } from '../../../../orchestration/session-links/session-link-mail-boundary'
import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { clampOrchestrationAskTimeoutMs } from '../../../../../../shared/orchestration-ask-timeout'
import { isGroupAddress } from '../../../../orchestration/addressing/groups/group-addressing'
import { dispatchReportMailbox } from '../../../../orchestration/workers/reports/dispatch-report-mailbox'
import { AskParams } from '../../../../../../shared/rpc-contract/orchestration-params'
import { rejectFederatedExplicitTarget } from '../routing'
import { askRemoteRunHome } from './ask-remote'
import {
  mailboxAddressOf,
  runCoordinatorKey
} from '../../../../orchestration/addressing/orchestration-caller-identity'
import { resolveOrchestrationParty } from '../../../../orchestration/addressing/orchestration-party'
import { assertLifecycleCallerIsNotAnotherParty } from './lifecycle-caller-fence'
import { assertWorkerCanReport } from '../../../../orchestration/workers/reports/worker-report-admission'
import { finishedWorkerDispatch, refuseFinishedRemoteWorker } from './finished-worker-mail'
import { isDispatchAssignee } from '../../../../orchestration/db/dispatch-context/dispatch-lookup'
import {
  askedQuestionReceipt,
  waitForQuestionAnswer
} from '../../../../orchestration/mailbox/questions/question-answer-delivery'

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
      const workingDispatch = db.getActiveDispatchForIdentity(from, paneKey)
      // A finished worker still asks its coordinator; the question changes nothing about its Task.
      const askingDispatch =
        workingDispatch ??
        finishedWorkerDispatch(
          db,
          {
            address: from,
            paneKey: paneKey ?? null,
            orcaSessionId: orchestrationCaller?.orcaSessionId ?? null,
            processIncarnation: () => runtime.getTerminalProcessIncarnation(from) ?? undefined
          },
          { run: undefined, dispatchId: undefined, dispatch: undefined },
          'question'
        )
      if (!askingDispatch) {
        refuseFinishedRemoteWorker(db, paneKey, undefined)
        throw new OrchestrationError(
          'dispatch_inactive',
          'ask requires an active supervised Dispatch.'
        )
      }
      if (workingDispatch) {
        assertWorkerCanReport({
          dispatchId: workingDispatch.id,
          from,
          workerState: db.getWorkerDispatch(workingDispatch.id)?.state,
          processCurrent:
            !workingDispatch.process_incarnation ||
            db.isDispatchProcessCurrent({
              dispatchId: workingDispatch.id,
              paneKey: paneKey ?? null,
              processIncarnation: runtime.getTerminalProcessIncarnation(from)
            })
        })
      }
      const options =
        params.options
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []
      let question = params.resume ? db.getQuestion(params.resume) : undefined
      if (params.resume) {
        // Its own question from a finished Dispatch stays resumable after a follow-up starts.
        const askedBy = question && db.getDispatchContextById(question.dispatch_id)
        if (!question || !askedBy || !isDispatchAssignee(askedBy, from, paneKey)) {
          throw new OrchestrationError(
            'question_not_found',
            `Question ${params.resume} does not belong to this active Dispatch.`
          )
        }
      } else {
        const run = db.getRun(askingDispatch.run_id)
        if (!run || run.legacy === 1) {
          throw new OrchestrationError(
            'run_not_found',
            `Run ${askingDispatch.run_id} was not found.`
          )
        }
        if (params.run && params.run !== run.id) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `Dispatch ${askingDispatch.id} belongs to Run ${run.id}, not ${params.run}.`
          )
        }
        const reportTo = dispatchReportMailbox(db, askingDispatch)
        if (
          params.to &&
          params.to !== `run:${run.id}` &&
          params.to !== reportTo &&
          resolveOrchestrationParty(params.to, db).address !==
            mailboxAddressOf(runCoordinatorKey(run))
        ) {
          throw new OrchestrationError(
            'dispatch_run_mismatch',
            `ask from Dispatch ${askingDispatch.id} must target its owning Run ${run.id}.`
          )
        }
        // An explicit Run or coordinator target still reaches the Run; otherwise the asker's creator.
        const to = params.to && params.to !== reportTo ? `run:${run.id}` : reportTo
        assertSessionLinkMailBoundary(db, orchestrationCaller?.orcaSessionId, to)
        const created = db.createQuestion({
          runId: run.id,
          dispatchId: askingDispatch.id,
          askerHandle: from,
          question: params.question as string,
          options,
          to
        })
        question = created.question
        runtime.notifyMessageArrived(to, created.message.type)
      }

      const questionId = question.message_id
      // A finished worker has no turn for an answer to wake, so it waits for it here.
      if (!params.resume && params.wait === false && workingDispatch) {
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
