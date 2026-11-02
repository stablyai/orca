import { randomUUID } from 'node:crypto'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeAgentPromptWriteOptions } from '../../runtime-terminal-contracts'
import { isAgentPromptStalledError } from '../../agent-prompt-submission-verification'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../../shared/generated-agent-input-readiness'
import type {
  GeneratedInputOutcome,
  GeneratedInputRequest
} from '../../../../shared/generated-terminal-input'
import { GeneratedInputRefusedError } from './generated-input-refused-error'

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

/** One generated write, admitted and written on this host; the outcome says what reached the PTY.
 *  The outcome settles at the operation's own deadline even while it waits behind another in the
 *  PTY's queue; when that queued run reaches the writer it finds the deadline passed and writes
 *  nothing, so a late drain cannot revive it. */
export async function deliverGeneratedTerminalInput(
  runtime: Pick<OrcaRuntimeService, 'sendTerminalAgentPrompt'>,
  handle: string,
  delivery: GeneratedInputDelivery
): Promise<GeneratedInputOutcome> {
  const progress = { pasted: false, submitted: false }
  const budget = Math.min(delivery.timeoutMs ?? Infinity, GENERATED_AGENT_INPUT_TIMEOUT_MS)
  const deadline = Date.now() + Math.max(0, budget)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<GeneratedInputOutcome>((resolve) => {
    const settleIfUnwritten = (): void => {
      // Once text is written the real outcome decides; it is bounded by the same deadline.
      if (!progress.pasted && !progress.submitted) {
        resolve('not-sent')
      }
    }
    timer = setTimeout(settleIfUnwritten, Math.max(0, deadline - Date.now()))
    // An abort raised inside the write itself is read after the writer records that write.
    delivery.signal?.addEventListener('abort', () => queueMicrotask(settleIfUnwritten), {
      once: true
    })
  })
  try {
    return await Promise.race([deliver(runtime, handle, delivery, deadline, progress), expired])
  } finally {
    clearTimeout(timer)
  }
}

async function deliver(
  runtime: Pick<OrcaRuntimeService, 'sendTerminalAgentPrompt'>,
  handle: string,
  delivery: GeneratedInputDelivery,
  deadline: number,
  progress: { pasted: boolean; submitted: boolean }
): Promise<GeneratedInputOutcome> {
  try {
    const sent = await runtime.sendTerminalAgentPrompt(handle, delivery.text, {
      inputKind: delivery.inputKind ?? 'launch',
      submit: delivery.submit,
      generatedAgent: delivery.agent ?? null,
      generatedIntent: delivery.intent ?? 'running',
      inputDeadline: deadline,
      ...(delivery.framing ? { framing: delivery.framing } : {}),
      ...(delivery.observedReady ? { observedReady: true } : {}),
      ...(delivery.composerReady !== undefined ? { composerReady: delivery.composerReady } : {}),
      ...(delivery.beforeWrite ? { beforeWrite: delivery.beforeWrite } : {}),
      ...(delivery.signal ? { signal: delivery.signal } : {}),
      onPasteWritten: () => {
        progress.pasted = true
      },
      onSubmitWritten: () => {
        progress.submitted = true
      },
      // Queued acceptance: the outcome is about input reaching the composer, not the turn.
      acceptQueued: true,
      requestId: randomUUID(),
      observationTimeoutMs: 0
    })
    if (!sent.accepted) {
      return progress.pasted ? 'unconfirmed' : 'not-sent'
    }
    return delivery.submit ? 'delivered' : 'staged'
  } catch (error) {
    if (progress.submitted || (progress.pasted && isAgentPromptStalledError(error))) {
      return 'delivered'
    }
    if (progress.pasted) {
      return 'unconfirmed'
    }
    if (error instanceof GeneratedInputRefusedError) {
      return 'not-sent'
    }
    return error instanceof Error && TARGET_GONE.has(error.message) ? 'target-gone' : 'not-sent'
  }
}
