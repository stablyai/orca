import type { CommandHandler } from '../../dispatch'
import { printResult } from '../../format'
import { withReceiptNext } from './receipt-next-text'
import { printOrchestrationResult } from './agent-view'
import { checkView } from './message-agent-views'
import { getOptionalStringFlag } from '../../flags'
import { RuntimeClientError } from '../../runtime-client'
import type { RuntimeRpcSuccess } from '../../runtime-client'
import {
  formatOrchestrationCheckText,
  prepareOrchestrationCheckOutput,
  type LegacyCompatibilityResult,
  type OrchestrationMessageSummary as MessageSummary
} from '../../../shared/orchestration-check-output'
import { startCheckKeepalive } from './check-keepalive'
import { callOrchestrationMutation } from './mutation-request'
import { getOptionalPositiveIntegerValueFlag } from './numeric-flags'
import { flushOrchestrationStdout, resolveCompatibilityCliCommand } from './runtime-compatibility'
import { orchestrationCallerLabel, resolveOrchestrationTerminalHandle } from './terminal-identity'

type CheckResult = {
  messages: MessageSummary[]
  count: number
  formatted?: string
  deliveryId?: string | null
  runId?: string
  timedOut?: boolean
  cancelled?: boolean
  connectionLost?: boolean
  legacyCompatibility?: LegacyCompatibilityResult
  next?: string
}

export const ORCHESTRATION_CHECK_HANDLER: Record<string, CommandHandler> = {
  'orchestration check': async ({ flags, client, cwd, json }) => {
    const wait = flags.has('wait')
    const peek = flags.has('peek')
    // Older runtimes ignore peek, making --unread --peek destructive.
    if ([flags.has('unread'), peek, flags.has('all')].filter(Boolean).length > 1) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Choose at most one message read mode: --unread, --peek, or --all.'
      )
    }
    const timeoutMs = getOptionalPositiveIntegerValueFlag(flags, 'timeout-ms')
    const explicitTerminal = getOptionalStringFlag(flags, 'terminal')
    const terminal = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')
    // Sessions use their injected id; inherited pane keys belong to a different caller.
    const paneKey =
      explicitTerminal || terminal === undefined ? undefined : process.env.ORCA_PANE_KEY
    const callerLabel = orchestrationCallerLabel(terminal)
    const stopKeepalive = wait ? startCheckKeepalive(timeoutMs) : null
    let result: Awaited<ReturnType<typeof client.call<CheckResult>>>
    try {
      result = await callOrchestrationMutation<CheckResult>(client, flags, 'orchestration.check', {
        terminal,
        terminalPaneKey: paneKey || undefined,
        // unread:false makes hosts that ignore peek fall back to non-consuming all mode.
        unread: flags.has('unread') ? true : peek ? false : undefined,
        peek: peek ? true : undefined,
        all: flags.has('all') ? true : undefined,
        types: getOptionalStringFlag(flags, 'types'),
        format: flags.has('format') ? true : undefined,
        inject: flags.has('inject') ? true : undefined,
        compatibilityCliCommand: resolveCompatibilityCliCommand(),
        run: getOptionalStringFlag(flags, 'run'),
        ack: getOptionalStringFlag(flags, 'ack'),
        wait: wait ? true : undefined,
        timeoutMs
      })
    } finally {
      stopKeepalive?.()
    }
    if (peek) {
      result = filterLegacyPeekResult(result, wait)
    }
    result = {
      ...result,
      result: prepareOrchestrationCheckOutput(result.result, callerLabel, flags.has('format'))
    }
    if (flags.has('full')) {
      printResult(result, json, (value) =>
        withReceiptNext(formatOrchestrationCheckText(value, callerLabel), value)
      )
    } else {
      printOrchestrationResult(result, json, checkView(callerLabel))
    }
    const compatibilityAck = result.result.legacyCompatibility?.ackMessageIds
    if (compatibilityAck && compatibilityAck.length > 0) {
      await flushOrchestrationStdout()
      await client.call('orchestration.check', {
        terminal,
        compatibilityAck: JSON.stringify({
          messageIds: compatibilityAck,
          types: getOptionalStringFlag(flags, 'types')
            ?.split(',')
            .map((type) => type.trim())
            .filter(Boolean)
        })
      })
    }
  }
}

function filterLegacyPeekResult(
  result: RuntimeRpcSuccess<CheckResult>,
  wait: boolean
): RuntimeRpcSuccess<CheckResult> {
  const rawRowCount = result.result.messages.length
  const unreadOnly = result.result.messages.filter((message) => message.read !== 1)
  const removedReadRows = unreadOnly.length !== rawRowCount
  // Read rows reveal an older runtime returning before the requested unread wait is satisfied.
  if (wait && removedReadRows && unreadOnly.length === 0) {
    throw new RuntimeClientError(
      'peek_wait_unsupported',
      'The connected runtime does not support --peek with --wait; upgrade the runtime or use --wait without --peek.'
    )
  }
  if (removedReadRows && rawRowCount >= 100) {
    console.error(
      'Warning: this runtime returned only its newest 100 messages for --peek; older unread messages may be missing. Upgrade the runtime for exact peek results.'
    )
  }
  return {
    ...result,
    result: {
      ...result.result,
      // Filtered rows invalidate the older host's preformatted output.
      ...(removedReadRows ? { formatted: undefined } : {}),
      messages: unreadOnly,
      count: unreadOnly.length
    }
  }
}
