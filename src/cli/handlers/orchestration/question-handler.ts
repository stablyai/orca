import type { CommandHandler } from '../../dispatch'
import { getOptionalStringFlag } from '../../flags'
import { printResult } from '../../format'
import { renderCommand } from '../../orchestration-mutation-recovery'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
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
    const result = await callOrchestrationMutation<{
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
    if (json) {
      printResult(result, true, () => '')
    } else if (result.result.pending) {
      console.log(withReceiptNext(`Question ${result.result.messageId} sent.`, result.result))
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
        // Report the server's effective budget, which may be clamped below the requested timeout.
        const waitedMs = result.result.timeoutMs ?? timeoutMs
        const messageId = result.result.messageId
        const dispatchCapability = getOptionalStringFlag(flags, 'dispatch-capability')
        const resumeCommand =
          messageId === null
            ? undefined
            : renderCommand([
                resolveOrchestrationCliExecutable(),
                'orchestration',
                'ask',
                // A session's resume is flagless: its injected id names it again.
                ...(from ? ['--from', from] : []),
                ...(dispatchCapability ? ['--dispatch-capability', dispatchCapability] : []),
                '--resume',
                messageId,
                '--timeout-ms',
                String(waitedMs)
              ])
        console.error(
          resumeCommand
            ? `ask timeout after ${waitedMs}ms; question is still pending (messageId: ${messageId}). Resume waiting; do not ask again:\n${resumeCommand}`
            : `ask timeout after ${waitedMs}ms; question identity was not returned, so it cannot be resumed safely.`
        )
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
