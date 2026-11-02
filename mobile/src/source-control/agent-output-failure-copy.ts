import type { AgentOutputFailureCode } from '../../../src/shared/agent-output-failure-copy'
import { translate } from '../i18n/mobile-i18n'

export const AGENT_OUTPUT_FAILURE_COPY: Record<
  AgentOutputFailureCode,
  (values: Record<string, string | number>) => string
> = {
  openCodeInvalidEvents: (values) =>
    translate(
      'sourceControl.textGenerationFailure.openCodeInvalidEvents',
      'OpenCode returned invalid JSON events.',
      values
    ),
  antigravityInvalidEvents: (values) =>
    translate(
      'sourceControl.textGenerationFailure.antigravityInvalidEvents',
      'Antigravity returned invalid JSON events.',
      values
    ),
  antigravityInvalidResult: (values) =>
    translate(
      'sourceControl.textGenerationFailure.antigravityInvalidResult',
      'Antigravity returned an invalid result.',
      values
    ),
  antigravityNoFinalResult: (values) =>
    translate(
      'sourceControl.textGenerationFailure.antigravityNoFinalResult',
      'Antigravity returned no final result.',
      values
    ),
  kimiUnreadableOutput: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiUnreadableOutput',
      "Kimi returned output Orca couldn't read. Try again.",
      values
    ),
  kimiSessionOccupied: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiSessionOccupied',
      "Kimi couldn't use this session because it is active in another client. Stop the session there or exit that client, then try again.",
      values
    ),
  kimiInterrupted: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiInterrupted',
      'Kimi was interrupted before it finished generating text. Try again.',
      values
    ),
  kimiFailed: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiFailed',
      "Kimi couldn't finish generating text. Open Kimi on the execution host to check the failure before retrying.",
      values
    ),
  kimiAgentOptionsConflict: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiAgentOptionsConflict',
      'Kimi received conflicting or repeated agent options. Keep a single --agent or --agent-file option in the generation recipe or CLI arguments, then retry.',
      values
    ),
  kimiOptionRejected: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiOptionRejected',
      'Kimi rejected an option or argument. Correct the generation recipe or CLI arguments, then retry.',
      values
    ),
  kimiSessionNotFound: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiSessionNotFound',
      "Kimi couldn't find the requested session. Use an existing session or start a new one.",
      values
    ),
  kimiSessionOtherDirectory: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiSessionOtherDirectory',
      'This Kimi session belongs to another directory. Resume it there or use a session created for this workspace.',
      values
    ),
  kimiCredentialVariableMissing: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiCredentialVariableMissing',
      'Kimi is missing a configured credential environment variable. Set it on the execution host before retrying.',
      values
    ),
  kimiCredentialsRequired: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiCredentialsRequired',
      'Kimi needs provider credentials. Open Kimi on the execution host to configure a provider or sign in, then retry.',
      values
    ),
  kimiModelMissing: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiModelMissing',
      'Kimi has no usable model configured. Open Kimi on the execution host to configure or select a model, then retry.',
      values
    ),
  kimiPromptHookBlocked: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiPromptHookBlocked',
      "A Kimi prompt hook blocked the request or the turn couldn't start. Review Kimi hooks and configuration before retrying.",
      values
    ),
  kimiCancelled: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiCancelled',
      'Kimi cancelled the request before it finished generating text. Try again.',
      values
    ),
  kimiEmptyPrompt: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiEmptyPrompt',
      'Kimi received an empty prompt. Correct that input in the generation recipe or CLI arguments, then retry.',
      values
    ),
  kimiEmptyModel: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiEmptyModel',
      'Kimi received an empty model. Correct that input in the generation recipe or CLI arguments, then retry.',
      values
    ),
  kimiEmptyAgent: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiEmptyAgent',
      'Kimi received an empty agent. Correct that input in the generation recipe or CLI arguments, then retry.',
      values
    ),
  kimiEmptyAgentFilePath: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiEmptyAgentFilePath',
      'Kimi received an empty agent file path. Correct that input in the generation recipe or CLI arguments, then retry.',
      values
    ),
  kimiOutputFormatInvalid: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiOutputFormatInvalid',
      'Kimi output format requires prompt mode and a supported text or stream-json value. Correct the generation recipe or CLI arguments before retrying.',
      values
    ),
  kimiSessionIdRequired: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiSessionIdRequired',
      'Kimi needs a session id to resume in prompt mode. Correct the generation recipe or CLI arguments, then retry.',
      values
    ),
  kimiConflictingOptions: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiConflictingOptions',
      'Kimi received conflicting options: {{option}} with {{otherOption}}. Correct the generation recipe or CLI arguments before retrying.',
      values
    ),
  kimiContinueSessionConflict: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiContinueSessionConflict',
      'Kimi received conflicting options: --continue, --session. Correct the generation recipe or CLI arguments before retrying.',
      values
    ),
  kimiAgentChangeOnResume: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiAgentChangeOnResume',
      'Kimi cannot change the agent when resuming a session. Remove the agent override or start a new session in the generation recipe or CLI arguments.',
      values
    ),
  kimiResponseBlocked: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiResponseBlocked',
      'Kimi could not return a response because it was blocked. Revise the prompt or model configuration before retrying.',
      values
    ),
  kimiAuthFailed: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiAuthFailed',
      'Kimi could not authenticate. Sign in or correct provider credentials on the execution host, then retry.',
      values
    ),
  kimiConnectionFailed: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiConnectionFailed',
      'Kimi could not connect to its provider. Check the network on the execution host, then retry.',
      values
    ),
  kimiProviderLimited: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiProviderLimited',
      'Kimi reached a provider limit or the provider is busy. Wait before retrying or reduce request frequency.',
      values
    ),
  kimiContextOverflow: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiContextOverflow',
      'Kimi ran out of context. Shorten the prompt or start a new session, then retry.',
      values
    ),
  kimiConfigInvalid: (values) =>
    translate(
      'sourceControl.textGenerationFailure.kimiConfigInvalid',
      'Kimi has invalid configuration. Check the model and provider configuration on the execution host before retrying.',
      values
    )
}
