import { randomUUID } from 'node:crypto'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { renderCommand } from '../orchestration-mutation-recovery'
import { RuntimeClientError } from '../runtime-client'
import { resolveOrchestrationCliExecutable } from '../runtime/orchestration-recovery-command'
import { injectedSessionAddress } from '../../shared/agent-session-caller-env'
import {
  clampOrchestrationAskTimeoutMs,
  resolveOrchestrationAskClientTimeoutMs
} from '../../shared/orchestration-ask-timeout'
import type {
  WorkInboxAnswer,
  WorkInboxAskResult,
  WorkInboxMutationResult
} from '../../shared/work-inbox'
import { getOptionalPositiveIntegerValueFlag } from './orchestration/numeric-flags'
import { flushOrchestrationStdout } from './orchestration/runtime-compatibility'
import { resolveOrchestrationTerminalHandle } from './orchestration/terminal-identity'

function formatAnswer(answer: WorkInboxAnswer): string {
  return [answer.optionLabel, answer.text].filter(Boolean).join('\n')
}

export const WORK_INBOX_ASK_HANDLERS: Record<string, CommandHandler> = {
  'inbox ack': async ({ flags, client, cwd, json }) => {
    const from =
      (await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')) ??
      injectedSessionAddress()
    const response = await client.call<WorkInboxMutationResult>('workInbox.ack', {
      id: getRequiredStringFlag(flags, 'id'),
      from
    })
    if (response.result.status !== 'ok') {
      throw new RuntimeClientError(
        'work_inbox_ack_rejected',
        'The question has no received answer to acknowledge.'
      )
    }
    printResult(response, json, () => 'Answer acknowledged.')
  },
  'inbox ask': async ({ flags, client, cwd, json }) => {
    const parsedTimeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
    const timeoutMs = clampOrchestrationAskTimeoutMs(parsedTimeoutMs)
    const question = getOptionalStringFlag(flags, 'question')
    const resume = getOptionalStringFlag(flags, 'resume')
    if ((question ? 1 : 0) + (resume ? 1 : 0) !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose exactly one of --question or --resume.'
      )
    }
    // Why: a chat session has no terminal handle; its session address still classifies the asker.
    const from =
      (await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')) ??
      injectedSessionAddress()
    const requestId = resume
      ? undefined
      : (getOptionalStringFlag(flags, 'request-id') ?? randomUUID())
    let response = await client
      .call<WorkInboxAskResult>(
        'workInbox.ask',
        {
          from,
          question,
          resume,
          options: getOptionalStringFlag(flags, 'options'),
          allowFreeText: flags.get('no-free-text') === true ? false : undefined,
          requestId,
          timeoutMs: parsedTimeoutMs === undefined ? undefined : timeoutMs
        },
        // Why: outlive the host's own deadline so the transport never aborts a live wait.
        { timeoutMs: resolveOrchestrationAskClientTimeoutMs(parsedTimeoutMs) }
      )
      .catch((error: unknown) => {
        if (requestId) {
          console.error(`Preserve the original question and retry with --request-id ${requestId}`)
        }
        throw error
      })
    // A host long-poll deadline is not a deadline for the human's answer.
    while (
      parsedTimeoutMs === undefined &&
      response.result.timedOut &&
      !response.result.answer &&
      !response.result.cancelled
    ) {
      const id = response.result.id
      response = await client
        .call<WorkInboxAskResult>(
          'workInbox.ask',
          { from, resume: id, timeoutMs },
          { timeoutMs: resolveOrchestrationAskClientTimeoutMs(timeoutMs) }
        )
        .catch((error: unknown) => {
          console.error(`Keep the question and resume with --resume ${id}`)
          throw error
        })
      if (response.result.id !== id) {
        throw new RuntimeClientError(
          'work_inbox_question_changed',
          'The Inbox returned a different question while waiting.'
        )
      }
    }
    const result = response.result
    if (json) {
      printResult(response, true, () => '')
    } else if (result.answer) {
      console.log(formatAnswer(result.answer))
    }
    if (result.answer && result.status === 'answered' && flags.get('no-ack') !== true) {
      // Why: acknowledge only after the answer reached stdout, so `delivered` means the agent has it.
      await flushOrchestrationStdout()
      try {
        const receipt = await client.call<WorkInboxMutationResult>('workInbox.ack', {
          id: result.id,
          from
        })
        if (receipt.result.status !== 'ok') {
          throw new RuntimeClientError(
            'work_inbox_ack_rejected',
            'The host did not acknowledge the answer receipt.'
          )
        }
      } catch (error) {
        console.error(
          `Answer printed, but acknowledging ${result.id} failed: ${error instanceof Error ? error.message : String(error)}`
        )
        throw new RuntimeClientError(
          'work_inbox_receipt_unconfirmed',
          `Answer already printed; acknowledge its receipt with inbox ack --id ${result.id}. Do not create a new question.`
        )
      }
    }
    if (result.cancelled) {
      if (!json) {
        console.error(
          `Question ${result.id}: the user closed it without providing an answer. This is not approval; do not choose a suggested option.`
        )
      }
      process.exitCode = 1
    } else if (result.timedOut) {
      if (!json) {
        const resumeCommand = renderCommand([
          resolveOrchestrationCliExecutable(),
          'inbox',
          'ask',
          '--resume',
          result.id,
          '--timeout-ms',
          String(result.timeoutMs)
        ])
        console.error(
          `No answer after ${result.timeoutMs}ms; question ${result.id} is still open. Keep waiting; do not ask again:\n${resumeCommand}`
        )
      }
      process.exitCode = 1
    }
  }
}
