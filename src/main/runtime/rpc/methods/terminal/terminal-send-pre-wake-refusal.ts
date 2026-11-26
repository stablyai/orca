import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../../shared/terminal/input/terminal-input'

type TerminalSendRefusalParams = {
  text?: string
  enter?: boolean
  interrupt?: boolean
  requireAgentStatus?: string
  resolvedLaunchDraft?: { text?: string }
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
export async function isTerminalSendRefusedBeforeWake(
  params: TerminalSendRefusalParams
): Promise<boolean> {
  if (isGuardedCombinedTerminalSend(params)) {
    return true
  }
  for (const text of [params.text, params.resolvedLaunchDraft?.text]) {
    if (
      text &&
      (await isTerminalInputTooLargeWithDeferredMeasurement(text, TERMINAL_INPUT_MAX_BYTES))
    ) {
      return true
    }
  }
  return false
}
