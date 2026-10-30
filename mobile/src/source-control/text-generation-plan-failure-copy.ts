import type { TextGenerationFailureCode } from '../../../src/shared/text-generation-failure-copy'
import { translate } from '../i18n/mobile-i18n'

export const TEXT_GENERATION_PLAN_FAILURE_COPY = {
  planCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGenerationFailure.planCustomCommandEmpty',
      'Custom command is empty. Add one in Settings → Git → AI Commit Messages.',
      values
    ),
  planAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGenerationFailure.planAgentUnsupported',
      'Agent "{{agent}}" does not support AI commit messages.',
      values
    ),
  planModelUnavailable: (values) =>
    translate(
      'sourceControl.textGenerationFailure.planModelUnavailable',
      'Model "{{model}}" is not available for {{label}}.',
      values
    ),
  planModelWithoutThinking: (values) =>
    translate(
      'sourceControl.textGenerationFailure.planModelWithoutThinking',
      'Model "{{model}}" does not support a thinking effort level.',
      values
    ),
  planThinkingLevelInvalid: (values) =>
    translate(
      'sourceControl.textGenerationFailure.planThinkingLevelInvalid',
      'Thinking level "{{level}}" is not valid for {{model}}.',
      values
    )
} satisfies Partial<
  Record<TextGenerationFailureCode, (values: Record<string, string | number>) => string>
>
