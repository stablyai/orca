import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import { isAgentPromptStalledError } from '../../agent-prompt-submission-verification'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../../shared/generated-agent-input-readiness'
import type {
  GeneratedInputOutcome,
  GeneratedInputRequest
} from '../../../../shared/generated-terminal-input'
import { GeneratedInputRefusedError } from './terminal-generated-input-admission'

export type GeneratedInputDelivery = GeneratedInputRequest &
  Pick<
    RuntimeAgentPromptWriteOptions,
    'framing' | 'observedReady' | 'composerReady' | 'beforeWrite' | 'signal'
  >

const TARGET_GONE = new Set([
  'terminal_handle_stale',
  'terminal_not_found',
  'terminal_not_writable'
])

/** One generated write, admitted and written on this host; the outcome says what reached the PTY. */
export async function deliverGeneratedTerminalInput(
  runtime: Pick<OrcaRuntimeService, 'sendTerminalAgentPrompt'>,
  handle: string,
  delivery: GeneratedInputDelivery
): Promise<GeneratedInputOutcome> {
  let pasted = false
  let submitted = false
  const budget = Math.min(delivery.timeoutMs ?? Infinity, GENERATED_AGENT_INPUT_TIMEOUT_MS)
  try {
    const sent = await runtime.sendTerminalAgentPrompt(handle, delivery.text, {
      inputKind: delivery.inputKind ?? 'launch',
      submit: delivery.submit,
      generatedAgent: delivery.agent ?? null,
      inputDeadline: Date.now() + Math.max(0, budget),
      ...(delivery.framing ? { framing: delivery.framing } : {}),
      ...(delivery.observedReady ? { observedReady: true } : {}),
      ...(delivery.composerReady !== undefined ? { composerReady: delivery.composerReady } : {}),
      ...(delivery.beforeWrite ? { beforeWrite: delivery.beforeWrite } : {}),
      ...(delivery.signal ? { signal: delivery.signal } : {}),
      onPasteWritten: () => {
        pasted = true
      },
      onSubmitWritten: () => {
        submitted = true
      },
      // Queued acceptance: the outcome is about input reaching the composer, not the turn.
      acceptQueued: true,
      requestId: randomUUID(),
      observationTimeoutMs: 0
    })
    if (!sent.accepted) {
      return pasted ? 'unconfirmed' : 'not-sent'
    }
    return delivery.submit ? 'delivered' : 'staged'
  } catch (error) {
    if (submitted || (pasted && isAgentPromptStalledError(error))) {
      return 'delivered'
    }
    if (pasted) {
      return 'unconfirmed'
    }
    if (error instanceof GeneratedInputRefusedError) {
      return 'not-sent'
    }
    return error instanceof Error && TARGET_GONE.has(error.message) ? 'target-gone' : 'not-sent'
  }
}
