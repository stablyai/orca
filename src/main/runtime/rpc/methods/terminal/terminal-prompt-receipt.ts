import type { RuntimeTerminalSend } from '../../../../../shared/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../../orca-runtime'

const TERMINAL_PROMPT_REPLAY_REPLACEMENT_ERRORS = new Set([
  'terminal_handle_stale',
  'terminal_not_writable',
  'terminal_gone',
  'terminal_exited'
])

export async function observeReplayedTerminalPrompt(
  runtime: OrcaRuntimeService,
  handle: string,
  replayedMutationReceipt: unknown,
  waitSubmitMs: number | undefined,
  signal: AbortSignal | undefined
): Promise<{ send: RuntimeTerminalSend } | null> {
  const replayedSend = (replayedMutationReceipt as { send?: RuntimeTerminalSend } | undefined)?.send
  if (!replayedSend?.prompt || !waitSubmitMs || waitSubmitMs <= 0) {
    return null
  }
  try {
    const prompt = await runtime.observeTerminalAgentPrompt(
      handle,
      replayedSend.prompt,
      waitSubmitMs,
      signal
    )
    return { send: { ...replayedSend, prompt } }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !TERMINAL_PROMPT_REPLAY_REPLACEMENT_ERRORS.has(error.message)
    ) {
      throw error
    }
    return {
      send: {
        ...replayedSend,
        prompt: { ...replayedSend.prompt, observation: 'incarnation_replaced' }
      }
    }
  }
}

export function ensureUnsupportedTerminalPromptReceipt(
  runtime: OrcaRuntimeService,
  handle: string,
  requestId: string,
  send: RuntimeTerminalSend
): RuntimeTerminalSend {
  if (send.prompt) {
    return send
  }
  const binding = runtime.getTerminalPromptRequestBinding(handle)
  return {
    ...send,
    prompt: {
      requestId,
      stages: ['input_accepted'],
      provider: 'unsupported',
      observation: 'unsupported',
      processIncarnation: binding.processIncarnation,
      generation: binding.generation,
      baselineWorkingSequence: 0
    }
  }
}
