import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../../shared/terminal/input/terminal-input'

type TerminalSendRefusalParams = {
  text?: unknown
  enter?: unknown
  interrupt?: unknown
  requireAgentStatus?: unknown
  resolvedLaunchDraft?: { text?: unknown }
}

function isSendParams(params: unknown): params is TerminalSendRefusalParams {
  return typeof params === 'object' && params !== null
}

/** Guarded sends are two-phase; combined payload/submit could partially deliver across a guard flip. */
export function isGuardedCombinedTerminalSend(params: TerminalSendRefusalParams): boolean {
  return (
    params.requireAgentStatus === 'sendable' &&
    typeof params.text === 'string' &&
    params.text.length > 0 &&
    (params.enter === true || params.interrupt === true)
  )
}

/** True when terminal.send refuses these params whatever the pane runs, so waking a slept agent first is wasted. */
export async function isTerminalSendRefusedBeforeWake(params: unknown): Promise<boolean> {
  if (!isSendParams(params)) {
    return false
  }
  if (isGuardedCombinedTerminalSend(params)) {
    return true
  }
  for (const text of [params.text, params.resolvedLaunchDraft?.text]) {
    if (
      typeof text === 'string' &&
      text &&
      (await isTerminalInputTooLargeWithDeferredMeasurement(text, TERMINAL_INPUT_MAX_BYTES))
    ) {
      return true
    }
  }
  return false
}
