import {
  TEXT_GENERATION_FAILURE_COPY as EN,
  type TextGenerationFailureCode
} from '../../../src/shared/text-generation-failure-copy'
import { translate } from '../i18n/mobile-i18n'
import { AGENT_OUTPUT_FAILURE_COPY } from './agent-output-failure-copy'
import { TEXT_GENERATION_PLAN_FAILURE_COPY } from './text-generation-plan-failure-copy'

type CopyValues = Record<string, string | number>

const COPY: Record<TextGenerationFailureCode, (values: CopyValues) => string> = {
  promptTooLargeForWindows: (values) =>
    translate(
      'sourceControl.textGenerationFailure.promptTooLargeForWindows',
      '{{label}} prompt is too large for the Windows command line. Stage fewer changes and try again.',
      values
    ),
  promptTooLargeForArgument: (values) =>
    translate(
      'sourceControl.textGenerationFailure.promptTooLargeForArgument',
      '{{label}} prompt is too large to pass as a single command-line argument. Stage fewer changes and try again.',
      values
    ),
  agentCouldNotStart: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentCouldNotStart',
      '{{label}} could not be started. Check the agent command in Settings and try again.',
      values
    ),
  agentFailedToStart: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentFailedToStart',
      '{{label}} failed to start. Check the agent command in Settings and try again.',
      values
    ),
  agentBinaryNotFound: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentBinaryNotFound',
      '{{binary}} not found on PATH. Install {{label}} to use AI commit messages.',
      values
    ),
  timedOut: (values) =>
    translate(
      'sourceControl.textGenerationFailure.timedOut',
      'Generation timed out after {{seconds}}s.',
      values
    ),
  outputTooLarge: (values) =>
    translate(
      'sourceControl.textGenerationFailure.outputTooLarge',
      '{{label}} CLI command produced too much output. Check the agent CLI configuration and try again.',
      values
    ),
  windowsBatchUnsafeArguments: (values) =>
    translate(
      'sourceControl.textGenerationFailure.windowsBatchUnsafeArguments',
      "{{label}} runs through a Windows batch script that cannot take the multi-line prompt as an argument. Point Settings at the agent's executable, or use a custom command without {prompt} so Orca sends the prompt on stdin.",
      values
    ),
  cliTerminated: (values) =>
    translate(
      'sourceControl.textGenerationFailure.cliTerminated',
      '{{label}} CLI command was terminated before exiting.',
      values
    ),
  cliTerminatedWithDetail: (values) =>
    translate(
      'sourceControl.textGenerationFailure.cliTerminatedWithDetail',
      '{{label}} CLI command was terminated before exiting: {{detail}}',
      values
    ),
  cliFailed: (values) =>
    translate(
      'sourceControl.textGenerationFailure.cliFailed',
      '{{label}} CLI command failed with code {{exitCode}}.',
      values
    ),
  cliFailedWithDetail: (values) =>
    translate(
      'sourceControl.textGenerationFailure.cliFailedWithDetail',
      '{{label}} CLI command failed with code {{exitCode}}: {{detail}}',
      values
    ),
  agentReportedError: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentReportedError',
      '{{label}} reported an error.',
      values
    ),
  emptyCommitMessage: (values) =>
    translate(
      'sourceControl.textGenerationFailure.emptyCommitMessage',
      '{{label}} returned an empty message.',
      values
    ),
  emptyCommitMessageWithDetail: (values) =>
    translate(
      'sourceControl.textGenerationFailure.emptyCommitMessageWithDetail',
      '{{label}} returned an empty message. CLI output: {{detail}}',
      values
    ),
  emptyPullRequestDetails: (values) =>
    translate(
      'sourceControl.textGenerationFailure.emptyPullRequestDetails',
      '{{label}} returned an empty details.',
      values
    ),
  emptyPullRequestDetailsWithDetail: (values) =>
    translate(
      'sourceControl.textGenerationFailure.emptyPullRequestDetailsWithDetail',
      '{{label}} returned an empty details. CLI output: {{detail}}',
      values
    ),
  emptyJiraSummary: (values) =>
    translate(
      'sourceControl.textGenerationFailure.emptyJiraSummary',
      '{{label}} returned an empty summary.',
      values
    ),
  emptyJiraSummaryWithDetail: (values) =>
    translate(
      'sourceControl.textGenerationFailure.emptyJiraSummaryWithDetail',
      '{{label}} returned an empty summary. CLI output: {{detail}}',
      values
    ),
  commitMessageUnparseable: (values) =>
    translate(
      'sourceControl.textGenerationFailure.commitMessageUnparseable',
      'Generated commit message could not be parsed.',
      values
    ),
  pullRequestDetailsUnparseable: (values) =>
    translate(
      'sourceControl.textGenerationFailure.pullRequestDetailsUnparseable',
      'Generated pull request details could not be parsed.',
      values
    ),
  jiraSummaryEmptyAfterSanitization: (values) =>
    translate(
      'sourceControl.textGenerationFailure.jiraSummaryEmptyAfterSanitization',
      'Generated summary was empty after sanitization.',
      values
    ),
  jiraDescriptionRequired: (values) =>
    translate(
      'sourceControl.textGenerationFailure.jiraDescriptionRequired',
      'Description is required.',
      values
    ),
  jiraAccountDisconnected: (values) =>
    translate(
      'sourceControl.textGenerationFailure.jiraAccountDisconnected',
      'Reconnect the selected Jira account on this host.',
      values
    ),
  jiraSummaryBusyInOtherDraft: (values) =>
    translate(
      'sourceControl.textGenerationFailure.jiraSummaryBusyInOtherDraft',
      'A Jira title is already being generated in another draft.',
      values
    ),
  stagedChangesReadFailed: (values) =>
    translate(
      'sourceControl.textGenerationFailure.stagedChangesReadFailed',
      'Failed to read staged changes.',
      values
    ),
  noStagedChanges: (values) =>
    translate(
      'sourceControl.textGenerationFailure.noStagedChanges',
      'No staged changes to summarize.',
      values
    ),
  noBranchChanges: (values) =>
    translate(
      'sourceControl.textGenerationFailure.noBranchChanges',
      'No branch changes to summarize.',
      values
    ),
  commandTemplateEmptyCommitMessage: (values) =>
    translate(
      'sourceControl.textGenerationFailure.commandTemplateEmptyCommitMessage',
      'Command template is empty for commit messages.',
      values
    ),
  commandTemplateEmptyPullRequest: (values) =>
    translate(
      'sourceControl.textGenerationFailure.commandTemplateEmptyPullRequest',
      'Command template is empty for pull request details.',
      values
    ),
  commandTemplateEmptyBranchName: (values) =>
    translate(
      'sourceControl.textGenerationFailure.commandTemplateEmptyBranchName',
      'Command template is empty for branch names.',
      values
    ),
  commandTemplateEmptyChatName: (values) =>
    translate(
      'sourceControl.textGenerationFailure.commandTemplateEmptyChatName',
      'Command template is empty for chat names.',
      values
    ),
  sourceControlAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGenerationFailure.sourceControlAgentUnsupported',
      'Choose a supported Source Control AI agent for this action in Settings -> Git -> Source Control AI. Supported agents: {{agents}}, or Custom command.',
      values
    ),
  chatNameAgentUnsupported: (values) =>
    translate(
      'sourceControl.textGenerationFailure.chatNameAgentUnsupported',
      'Choose a supported chat name agent for this action in Settings -> Chat -> Chat names. Supported agents: {{agents}}, or Custom command.',
      values
    ),
  sourceControlCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGenerationFailure.sourceControlCustomCommandEmpty',
      'Custom command is empty. Add one in Settings -> Git -> Source Control AI.',
      values
    ),
  chatNameCustomCommandEmpty: (values) =>
    translate(
      'sourceControl.textGenerationFailure.chatNameCustomCommandEmpty',
      'Custom command is empty. Add one in Settings -> Chat -> Chat names.',
      values
    ),
  agentCannotGenerateCommitMessage: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentCannotGenerateCommitMessage',
      'Agent "{{agent}}" does not support Source Control AI commit messages. Supported agents: {{agents}}, or Custom command.',
      values
    ),
  agentCannotGeneratePullRequest: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentCannotGeneratePullRequest',
      'Agent "{{agent}}" does not support Source Control AI pull request details. Supported agents: {{agents}}, or Custom command.',
      values
    ),
  agentCannotGenerateBranchName: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentCannotGenerateBranchName',
      'Agent "{{agent}}" does not support Source Control AI branch names. Supported agents: {{agents}}, or Custom command.',
      values
    ),
  agentCannotGenerateChatName: (values) =>
    translate(
      'sourceControl.textGenerationFailure.agentCannotGenerateChatName',
      'Agent "{{agent}}" does not support chat names. Supported agents: {{agents}}, or Custom command.',
      values
    ),
  noModelForAgent: (values) =>
    translate(
      'sourceControl.textGenerationFailure.noModelForAgent',
      'No model is available for {{label}}.',
      values
    ),
  ...TEXT_GENERATION_PLAN_FAILURE_COPY,
  ...AGENT_OUTPUT_FAILURE_COPY
}

function isTextGenerationFailureCode(code: unknown): code is TextGenerationFailureCode {
  return typeof code === 'string' && Object.hasOwn(COPY, code)
}

type TextGenerationFailure = {
  error: string
  errorCode?: unknown
  errorParams?: unknown
  errorDetail?: unknown
}

export function textGenerationErrorText(failure: TextGenerationFailure): string {
  if (!isTextGenerationFailureCode(failure.errorCode)) {
    return failure.error
  }
  const params: Record<string, unknown> =
    typeof failure.errorParams === 'object' && failure.errorParams !== null
      ? { ...failure.errorParams }
      : {}
  const values: CopyValues = {}
  for (const [, slot] of EN[failure.errorCode].matchAll(/\{\{(\w+)\}\}/g)) {
    const value = slot === 'detail' ? failure.errorDetail : params[slot]
    if (typeof value !== 'string' && typeof value !== 'number') {
      return failure.error
    }
    values[slot] = value
  }
  return COPY[failure.errorCode](values)
}
