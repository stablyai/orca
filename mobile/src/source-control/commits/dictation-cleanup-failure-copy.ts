import type { TextGenerationFailureCode } from '../../../../src/shared/text-generation-failure-copy'
import { translate } from '../../i18n/mobile-i18n'

export const DICTATION_CLEANUP_FAILURE_COPY = {
  commandTemplateEmptyDictationCleanup: (values) =>
    translate(
      'sourceControl.textGenerationFailure.commandTemplateEmptyDictationCleanup',
      'Command template is empty for dictation cleanup.',
      values
    ),
  dictationCleanupAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGenerationFailure.dictationCleanupAgentUnsupported',
      'Choose a supported agent for AI cleanup in Settings -> Voice -> Cleanup. Supported agents: {{agents}}, or Custom command.',
      values
    ),
  agentCannotGenerateDictationCleanup: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentCannotGenerateDictationCleanup',
      'Agent "{{agent}}" does not support dictation cleanup. Supported agents: {{agents}}, or Custom command.',
      values
    )
} satisfies Partial<
  Record<TextGenerationFailureCode, (values: Record<string, string | number>) => string>
>
