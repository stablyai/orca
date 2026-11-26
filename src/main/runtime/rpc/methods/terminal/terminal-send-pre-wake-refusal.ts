import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  TERMINAL_INPUT_MAX_BYTES
} from '../../../../../shared/terminal/input/terminal-input'
import { assertTerminalSendTextWithinLimit } from './terminal-input-delivery'

type TerminalSendRefusalParams = {
  text?: unknown
  enter?: unknown
  interrupt?: unknown
  requireAgentStatus?: unknown
  resolvedLaunchDraft?: { text?: unknown }
}

// Params whose text was already measured within the limit, so the handler doesn't scan it again.
const measuredWithinLimit = new WeakSet<object>()

/** The handler's size check, skipped for params the executor already measured within the limit. */
export async function assertTerminalSendTextsWithinLimit(params: {
  text?: string
  resolvedLaunchDraft?: { text?: string }
}): Promise<void> {
  if (!measuredWithinLimit.has(params)) {
    await assertTerminalSendTextWithinLimit(params.text)
    await assertTerminalSendTextWithinLimit(params.resolvedLaunchDraft?.text)
  }
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
  measuredWithinLimit.add(params)
  return false
}
