import type { RuntimeTerminalSend } from '../../shared/runtime-types'
import { TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import type { CommandHandler } from '../dispatch'
import { formatTerminalSend, printResult, terminalSendWarnings } from '../format'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { readRetryRequestFlag } from '../retry-request-flag'
import { RuntimeClientError } from '../runtime-client'
import { attachUnverifiedTerminalPromptRecovery } from '../runtime/terminal-prompt-mutation-recovery'
import { getTerminalHandle } from '../selectors'

type TerminalSendResult = { send: RuntimeTerminalSend; warnings?: string[] }

export const terminalSendHandler: CommandHandler = async ({ flags, client, cwd, json }) => {
  const text = getOptionalStringFlag(flags, 'text')
  const enter = flags.get('enter') === true
  const interrupt = flags.get('interrupt') === true
  const promptCandidate = !!text && enter && !interrupt
  const retryRequest = readRetryRequestFlag(flags)
  const waitSubmitSeconds = getOptionalPositiveIntegerFlag(flags, 'wait-submit')
  if ((retryRequest || waitSubmitSeconds) && !promptCandidate) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--retry-request and --wait-submit require --text with --enter and without --interrupt.'
    )
  }
  if (waitSubmitSeconds && waitSubmitSeconds > 3600) {
    throw new RuntimeClientError('invalid_argument', '--wait-submit must be at most 3600 seconds.')
  }
  const waitSubmitMs = waitSubmitSeconds ? waitSubmitSeconds * 1000 : undefined
  let promptDeliverySupported = false
  let promptDeliveryRuntimeId: string | null = null
  if (promptCandidate) {
    const status = await client.getCliStatus()
    if (!status.result.runtime.reachable) {
      throw new RuntimeClientError(
        'runtime_unavailable',
        'Orca could not verify prompt-delivery support, so no input was sent. Wait for the execution host to become reachable and retry.'
      )
    }
    promptDeliverySupported =
      status.result.runtime.capabilities?.includes(TERMINAL_PROMPT_DELIVERY_RUNTIME_CAPABILITY) ===
      true
    promptDeliveryRuntimeId = status.result.runtime.runtimeId
  }
  if (retryRequest && !promptDeliverySupported) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot honor --retry-request and never recorded this request ID. This attempt sent no input, but an earlier prompt may have been delivered; inspect the terminal and do not resend unless you independently prove it was not delivered, because updating the host cannot make this specific retry idempotent.'
    )
  }
  if (waitSubmitMs && !promptDeliverySupported) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host does not support --wait-submit. No input was sent; update Orca on the execution host, or omit only --wait-submit for a legacy prompt whose delivery cannot be observed or retried safely.'
    )
  }
  const params = {
    terminal: await getTerminalHandle(flags, cwd, client),
    text,
    enter,
    interrupt,
    ...(promptCandidate
      ? {
          agentPrompt: true as const,
          ...(waitSubmitMs ? { waitSubmitMs } : {})
        }
      : {}),
    client: { id: 'orca-cli', type: 'desktop' }
  }
  const options = promptDeliverySupported
    ? {
        terminalPromptPreflight: { runtimeId: promptDeliveryRuntimeId },
        ...(retryRequest ? { orchestrationRequestId: retryRequest } : {}),
        ...(waitSubmitMs ? { timeoutMs: waitSubmitMs + 10_000 } : {})
      }
    : promptCandidate
      ? { legacyTerminalPrompt: true as const }
      : undefined
  const result = options
    ? await client.call<TerminalSendResult>('terminal.send', params, options)
    : await client.call<TerminalSendResult>('terminal.send', params)
  const missingPromptReceipt =
    promptCandidate && result.result.send.accepted && !result.result.send.prompt
  if (missingPromptReceipt && promptDeliverySupported) {
    throw attachUnverifiedTerminalPromptRecovery(
      new RuntimeClientError(
        'incompatible_runtime',
        'The Orca host changed after prompt-delivery support was verified and accepted input without returning a durable prompt receipt.'
      )
    )
  }
  if (missingPromptReceipt) {
    result.result.send.prompt = {
      requestId: 'unsupported-old-host',
      stages: ['input_accepted'],
      provider: 'old-host',
      observation: 'unsupported',
      processIncarnation: 'unknown',
      generation: 0,
      baselineWorkingSequence: 0
    }
  }
  // Why: the delivery warnings only existed in the text formatter, so --json callers never saw them.
  const warnings = terminalSendWarnings(result.result.send)
  printResult(
    warnings.length > 0 ? { ...result, result: { ...result.result, warnings } } : result,
    json,
    formatTerminalSend
  )
  if (!result.result.send.accepted) {
    process.exitCode = 1
  }
}
