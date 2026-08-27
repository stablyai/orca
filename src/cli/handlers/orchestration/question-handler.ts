import type { CommandHandler } from '../../dispatch'
import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import {
  clampOrchestrationAskTimeoutMs,
  resolveOrchestrationAskClientTimeoutMs
} from '../../../shared/orchestration-ask-timeout'
import type { LegacyCompatibilityResult } from '../../../shared/orchestration-check-output'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import {
  flushOrchestrationStdout,
  resolveCompatibilityCliCommand,
  resolvePackagedWindowsCompatibilityCommand
} from './runtime-compatibility'
import { resolveOrchestrationTerminalHandle } from './terminal-identity'

export const ORCHESTRATION_QUESTION_HANDLER: Record<string, CommandHandler> = {
  'orchestration ask': async ({ flags, client, cwd, json }) => {
    const parsedTimeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
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
    const result = await callOrchestrationMutation<{
      answer: string | null
      messageId: string | null
      threadId: string
      timedOut: boolean
      timeoutMs?: number
      cancelled?: boolean
      connectionLost?: boolean
      answerMessageId?: string | null
      legacyCompatibility?: LegacyCompatibilityResult
    }>(
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
        from,
        compatibilityCliCommand: resolveCompatibilityCliCommand(),
        compatibilityWindowsCommand: resolvePackagedWindowsCompatibilityCommand()
      },
      // Why: extend past timeoutMs so transport does not abort before the runtime resolves its timeout.
      {
        timeoutMs: resolveOrchestrationAskClientTimeoutMs(parsedTimeoutMs),
        orchestrationCapability: getOptionalStringFlag(flags, 'dispatch-capability')
      }
    )
    // Why: ask JSON is intentionally a bare object for `jq -r .answer`, unlike other verbs.
    if (json) {
      console.log(JSON.stringify(result.result))
    } else if (result.result.legacyCompatibility?.resumeRequired) {
      console.log(`Question ${result.result.messageId} committed.`)
      console.log(`Resume with: ${result.result.legacyCompatibility.resumeCommand}`)
    } else if (result.result.answer !== null) {
      console.log(result.result.answer)
    }
    if (result.result.legacyCompatibility?.resumeRequired) {
      await flushOrchestrationStdout()
      process.exitCode = 75
      return
    }
    const answerAck = result.result.legacyCompatibility?.answerAcknowledgement
    if (answerAck && result.result.answer !== null) {
      await flushOrchestrationStdout()
      await client.call('orchestration.check', {
        terminal: from,
        compatibilityQuestionAck: JSON.stringify(answerAck)
      })
    }
    if (result.result.timedOut) {
      if (!json) {
        // Why: report the server's clamped effective budget rather than overstating the wait.
        const waitedMs = result.result.timeoutMs ?? timeoutMs
        console.error(`ask timeout after ${waitedMs}ms (thread ${result.result.threadId})`)
      }
      process.exitCode = 1
    }
    if (result.result.cancelled) {
      if (!json) {
        console.error(
          result.result.connectionLost
            ? `ask connection closed (question ${result.result.messageId})`
            : `ask cancelled (question ${result.result.messageId})`
        )
      }
      process.exitCode = 1
    }
  }
}
