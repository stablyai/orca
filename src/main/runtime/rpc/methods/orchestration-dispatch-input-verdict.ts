import { TERMINAL_INPUT_TOO_LARGE_ERROR } from '../../../../shared/terminal-input'

// Why: since #14962 an unsubmitted preamble throws instead of being recorded as
// accepted, so the verdict lived only in the exception. Effects are what the
// Dispatch keeps, so the cause is written there next to the accepted receipt.
// The set is every failure sendTerminalAgentPrompt can raise: the submission
// verdicts, the writability/identity gates it reaches through the handle, the
// 16 MiB input guard, and the not-ready renderer graph.
const DISPATCH_INPUT_FAILURE_CAUSES = [
  'agent_prompt_stalled',
  'agent_prompt_blocked',
  'terminal_handle_stale',
  'terminal_not_writable',
  'terminal_exited',
  'terminal_gone',
  'terminal_input_too_large',
  'runtime_unavailable',
  'request_aborted'
] as const

export type DispatchInputFailureCause = (typeof DISPATCH_INPUT_FAILURE_CAUSES)[number] | 'unknown'

export type DispatchInputEffect = {
  kind: 'dispatch_input'
  role: 'agent'
  id: string
  state: 'accepted' | 'failed'
  cause?: DispatchInputFailureCause
  detail?: string
}

export function dispatchInputAcceptedEffect(terminalHandle: string): DispatchInputEffect {
  return { kind: 'dispatch_input', role: 'agent', id: terminalHandle, state: 'accepted' }
}

export function dispatchInputFailedEffect(
  terminalHandle: string,
  error: unknown
): DispatchInputEffect {
  const detail = error instanceof Error ? error.message : String(error)
  return {
    kind: 'dispatch_input',
    role: 'agent',
    id: terminalHandle,
    state: 'failed',
    cause: classifyDispatchInputFailure(error, detail),
    detail
  }
}

// Why: the runtime throws bare Errors whose message is the stable code, while
// OrchestrationError carries it on `code`. Read both, and keep anything else
// as 'unknown' so the vocabulary a reader branches on stays closed.
function classifyDispatchInputFailure(error: unknown, detail: string): DispatchInputFailureCause {
  // Why: the 16 MiB guard is the one gate that throws prose instead of a code,
  // so it needs an explicit mapping to stay a token a reader can branch on.
  if (detail === TERMINAL_INPUT_TOO_LARGE_ERROR) {
    return 'terminal_input_too_large'
  }
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : detail
  return (DISPATCH_INPUT_FAILURE_CAUSES as readonly string[]).includes(code)
    ? (code as DispatchInputFailureCause)
    : 'unknown'
}
