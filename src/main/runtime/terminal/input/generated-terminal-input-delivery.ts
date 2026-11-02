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

/** One generated write on this host: the shared operation below `sendTerminalAgentPrompt` owns its
 *  deadline, queue turn and outcome; this maps the writer's result to the typed outcome. */
export async function deliverGeneratedTerminalInput(
  runtime: Pick<OrcaRuntimeService, 'sendTerminalAgentPrompt'>,
  handle: string,
  delivery: GeneratedInputDelivery
): Promise<GeneratedInputOutcome> {
  const budget = Math.min(delivery.timeoutMs ?? Infinity, GENERATED_AGENT_INPUT_TIMEOUT_MS)
  const deadline = Date.now() + Math.max(0, budget)
  // The definite outcome answers at once; optional retries and turn observation finish behind it.
  let definite!: (outcome: GeneratedInputOutcome) => void
  const settled = new Promise<GeneratedInputOutcome>((resolve) => {
    definite = resolve
  })
  return await Promise.race([
    settled,
    deliver(runtime, handle, delivery, deadline, { pasted: false, submitted: false }, definite)
  ])
}

async function deliver(
  runtime: Pick<OrcaRuntimeService, 'sendTerminalAgentPrompt'>,
  handle: string,
  delivery: GeneratedInputDelivery,
  deadline: number,
  progress: { pasted: boolean; submitted: boolean },
  definite: (outcome: GeneratedInputOutcome) => void
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
      ...(delivery.requireConsumer ? { requireConsumer: true } : {}),
      onGeneratedOutcome: definite,
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
