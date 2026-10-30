import type { CommandHandler } from '../../dispatch'
import { getOptionalStringFlag } from '../../flags'
import { printResult } from '../../format'
import {
  printOrchestrationFields,
  reportOrchestrationFailure,
  resolveOrcaCommandsInText
} from './agent-view'
import { renderCommand } from '../../orchestration-mutation-recovery'
import {
  RuntimeClientError,
  type RuntimeClient,
  type RuntimeRpcSuccess
} from '../../runtime-client'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { ORCHESTRATION_ASK_RETURNS_AT_ONCE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { resolveOrchestrationCliExecutable } from '../../runtime/orchestration-recovery-command'
import {
  clampOrchestrationAskTimeoutMs,
  ORCHESTRATION_ASK_MAX_TIMEOUT_MS,
  resolveOrchestrationAskClientTimeoutMs
} from '../../../shared/orchestration-ask-timeout'
import type { LegacyCompatibilityResult } from '../../../shared/orchestration-check-output'
import { callOrchestrationMutation } from './mutation-request'
import { withReceiptNext } from './receipt-next-text'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import {
  flushOrchestrationStdout,
  resolveCompatibilityCliCommand,
  resolvePackagedWindowsCompatibilityCommand
} from './runtime-compatibility'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

async function runtimeLacksAskAtOnce(client: RuntimeClient): Promise<boolean> {
  const status = await client.call<RuntimeStatus>('status.get')
  return !status.result.capabilities?.includes(ORCHESTRATION_ASK_RETURNS_AT_ONCE_RUNTIME_CAPABILITY)
}

export const ORCHESTRATION_QUESTION_HANDLER: Record<string, CommandHandler> = {
  'orchestration ask': async ({ flags, client, cwd, json }) => {
    const parsedTimeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
    if (parsedTimeoutMs !== undefined && parsedTimeoutMs > ORCHESTRATION_ASK_MAX_TIMEOUT_MS) {
      throw new RuntimeClientError(
        'invalid_argument',
        `--timeout-ms must be at most ${ORCHESTRATION_ASK_MAX_TIMEOUT_MS} (30 minutes) per wait. For longer waits, resume the same question after a timeout.`
      )
    }
    const timeoutMs = clampOrchestrationAskTimeoutMs(parsedTimeoutMs)
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const question = getOptionalStringFlag(flags, 'question')
    const resume = getOptionalStringFlag(flags, 'resume')
    if ((question ? 1 : 0) + (resume ? 1 : 0) !== 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose exactly one of --question or --resume.'
      )
    }
    if (resume && flags.has('options')) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--options is only valid when creating a new question.'
      )
    }
    // Only a new question returns at once, and only from an Orca that can; resume and --wait still wait.
    const wait =
      resume !== undefined ||
      flags.has('wait') ||
      (await runtimeLacksAskAtOnce(client).catch(() => true))
    const result = await callOrchestrationMutation<AskResult>(
      client,
      flags,
      'orchestration.ask',
      {
        to: getOptionalStringFlag(flags, 'to'),
        run: getOptionalStringFlag(flags, 'run'),
        question,
        resume,
        options: getOptionalStringFlag(flags, 'options'),
        timeoutMs: parsedTimeoutMs === undefined ? undefined : timeoutMs,
        ...(wait ? {} : { wait: false }),
        from,
        compatibilityCliCommand: resolveCompatibilityCliCommand(),
        compatibilityWindowsCommand: resolvePackagedWindowsCompatibilityCommand()
      },
      // Outlive the server timeout so its result arrives before the transport aborts.
      {
        timeoutMs: resolveOrchestrationAskClientTimeoutMs(parsedTimeoutMs),
        orchestrationCapability: getOptionalStringFlag(flags, 'dispatch-capability')
      }
    )
    const value = result.result
    // Report the server's effective budget, which may be clamped below the requested timeout.
    const waitedMs = value.timeoutMs ?? timeoutMs
    const dispatchCapability = getOptionalStringFlag(flags, 'dispatch-capability')
    const resumeCommand =
      value.timedOut && value.messageId !== null
        ? renderCommand([
            resolveOrchestrationCliExecutable(),
            'orchestration',
            'ask',
            // A session's resume is flagless: its injected id names it again.
            ...(from ? ['--from', from] : []),
            ...(dispatchCapability ? ['--dispatch-capability', dispatchCapability] : []),
            '--resume',
            value.messageId,
            '--timeout-ms',
            String(waitedMs)
          ])
        : undefined
    if (flags.has('full')) {
      printFullAskResult(result, json)
    } else {
      const fields = {
        ...(value.answer !== null ? { answer: value.answer } : {}),
        messageId: value.messageId,
        ...(value.threadId && value.threadId !== value.messageId
          ? { threadId: value.threadId }
          : {}),
        ...(value.pending ? { pending: true } : {}),
        ...(value.timedOut ? { timedOut: true, timeoutMs: waitedMs } : {}),
        ...(value.cancelled ? { cancelled: true } : {}),
        ...(value.connectionLost ? { connectionLost: true } : {}),
        next: resumeCommand
          ? `Resume waiting; do not ask again: ${resumeCommand}`
          : value.legacyCompatibility?.resumeRequired
            ? `Resume with: ${value.legacyCompatibility.resumeCommand}`
            : value.next && resolveOrcaCommandsInText(value.next)
      }
      printOrchestrationFields(json, fields, (shown) =>
        shown.answer !== undefined
          ? shown.answer
          : withReceiptNext(
              value.pending
                ? `Question ${shown.messageId} sent.`
                : value.legacyCompatibility?.resumeRequired
                  ? `Question ${shown.messageId} committed.`
                  : value.timedOut
                    ? `Question ${shown.messageId ?? '(unknown id)'} is still pending after ${waitedMs}ms.`
                    : `Wait for question ${shown.messageId} ${value.connectionLost ? 'lost its connection' : 'was cancelled'}.`,
              shown
            )
      )
    }
    if (value.legacyCompatibility?.resumeRequired) {
      await flushOrchestrationStdout()
      reportOrchestrationFailure({
        code: 'ask_resume_required',
        message: `Question ${value.messageId} was committed; resume it to wait for the answer.`,
        exitCode: 75
      })
      return
    }
    const answerAck = value.legacyCompatibility?.answerAcknowledgement
    if (answerAck && value.answer !== null) {
      await flushOrchestrationStdout()
      await client.call('orchestration.check', {
        terminal: from,
        compatibilityQuestionAck: JSON.stringify(answerAck)
      })
    }
    // One stderr line in every mode; the resume command rides on it so --full stdout stays as before.
    if (value.timedOut) {
      reportOrchestrationFailure({
        code: 'ask_timeout',
        message: resumeCommand
          ? `ask timeout after ${waitedMs}ms; question ${value.messageId} is still pending. Resume waiting; do not ask again: ${resumeCommand}`
          : `ask timeout after ${waitedMs}ms; question identity was not returned, so it cannot be resumed safely.`
      })
    } else if (value.cancelled) {
      reportOrchestrationFailure({
        code: value.connectionLost ? 'ask_connection_closed' : 'ask_cancelled',
        message: `ask ${value.connectionLost ? 'connection closed' : 'cancelled'} (question ${value.messageId})`
      })
    }
  }
}

type AskResult = {
  answer: string | null
  messageId: string | null
  threadId: string
  timedOut: boolean
  timeoutMs?: number
  cancelled?: boolean
  connectionLost?: boolean
  answerMessageId?: string | null
  pending?: boolean
  next?: string
  legacyCompatibility?: LegacyCompatibilityResult
}

function printFullAskResult(result: RuntimeRpcSuccess<AskResult>, json: boolean): void {
  const value = result.result
  if (json) {
    printResult(result, true, () => '')
    return
  }
  if (value.pending) {
    console.log(withReceiptNext(`Question ${value.messageId} sent.`, value))
  } else if (value.legacyCompatibility?.resumeRequired) {
    console.log(`Question ${value.messageId} committed.`)
    console.log(`Resume with: ${value.legacyCompatibility.resumeCommand}`)
  } else if (value.answer !== null) {
    console.log(value.answer)
  }
}
