import { ON_DEVICE_TEXT_GENERATION_CHAR_BUDGET } from '../../shared/on-device-text-generation'
import { textGenerationFailure } from '../../shared/text-generation-failure-copy'
import {
  generateOnDeviceText,
  type OnDeviceModelFailureKind
} from '../on-device-model/on-device-model-client'
import type { InternalTextGenerationResult } from './source-control-text-generation-types'

export const ON_DEVICE_TEXT_GENERATION_LABEL = 'On-device (Apple Intelligence)'

export async function runOnDeviceTextGeneration(input: {
  prompt: string
  customPrompt?: string
  shouldExecute?: () => boolean
  timeoutMs?: number
  /** Test seam: the production path spawns the Foundation Models helper. */
  generate?: typeof generateOnDeviceText
}): Promise<InternalTextGenerationResult> {
  if (input.shouldExecute && !input.shouldExecute()) {
    return { success: false, error: 'Generation canceled.', canceled: true }
  }

  // Fail before spawning: the helper would reject an oversized prompt anyway, and trimming here
  // would silently produce a wrong commit message instead of a clear pick-another-agent error.
  if (input.prompt.length > ON_DEVICE_TEXT_GENERATION_CHAR_BUDGET) {
    return {
      success: false,
      ...textGenerationFailure('onDeviceModelContextExceeded')
    }
  }

  const result = await (input.generate ?? generateOnDeviceText)({
    prompt: input.prompt,
    instructions: input.customPrompt,
    shouldCancel: input.shouldExecute,
    timeoutMs: input.timeoutMs
  })
  if (result.ok) {
    return { success: true, rawOutput: result.text, agentLabel: ON_DEVICE_TEXT_GENERATION_LABEL }
  }
  if (result.kind === 'canceled') {
    return { success: false, error: 'Generation canceled.', canceled: true }
  }
  return { success: false, ...failureFor(result.kind, result.detail) }
}

function failureFor(
  kind: Exclude<OnDeviceModelFailureKind, 'canceled'>,
  detail?: string
): ReturnType<typeof textGenerationFailure> {
  switch (kind) {
    case 'missing':
    case 'unavailable':
      return textGenerationFailure('onDeviceModelUnavailable')
    case 'context':
      return textGenerationFailure('onDeviceModelContextExceeded')
    case 'refusal':
      return textGenerationFailure('onDeviceModelRefused')
    case 'locale':
      return textGenerationFailure('onDeviceModelLocale')
    case 'busy':
      return textGenerationFailure('onDeviceModelBusy')
    case 'timeout':
      return textGenerationFailure('timedOut', { seconds: 60 })
    case 'failed':
      return textGenerationFailure('onDeviceModelFailed', { detail: detail ?? kind })
  }
}
