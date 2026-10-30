import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues,
  AgentSessionFailureSay
} from '../../../src/shared/agent-session-failure-copy'
import { translate } from '../i18n/mobile-i18n'
import { START_FAILURE_COPY } from './agent-session-start-failure-copy'
import { SEND_FAILURE_COPY } from './agent-session-send-failure-copy'

const COPY: Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string> = {
  ...START_FAILURE_COPY,
  ...SEND_FAILURE_COPY,
  backgroundTasksRunning: (values) =>
    translate(
      'session.failure.backgroundTasksRunning',
      'Background tasks are still running.',
      values
    ),
  waitForBackgroundTasks: (values) =>
    translate(
      'session.failure.waitForBackgroundTasks',
      'Wait for the background tasks to finish.',
      values
    ),
  agentStarting: (values) =>
    translate('session.failure.agentStarting', 'The agent is still starting.', values),
  waitForStart: (values) =>
    translate('session.failure.waitForStart', 'Wait for the agent to finish starting.', values),
  agentStillWorking: (values) =>
    translate('session.failure.agentStillWorking', 'The agent is still working.', values),
  runCommandWhenDone: (values) =>
    translate('session.failure.runCommandWhenDone', "Run /{{command}} when it's done.", values),
  commandAfterAnswer: (values) =>
    translate(
      'session.failure.commandAfterAnswer',
      "Answer the agent's question or approval, then run /{{command}}.",
      values
    ),
  compactionFailed: (values) =>
    translate('session.failure.compactionFailed', 'Compaction failed.', values),
  compactionFailedQuoted: (values) =>
    translate('session.failure.compactionFailedQuoted', 'Compaction failed: {{detail}}.', values),
  compactionUnconfirmed: (values) =>
    translate(
      'session.failure.compactionUnconfirmed',
      'Compaction completion is unconfirmed.',
      values
    ),
  cancelUnconfirmed: (values) =>
    translate('session.failure.cancelUnconfirmed', 'Cancellation was not confirmed.', values),
  stopRefused: (values) =>
    translate('session.failure.stopRefused', "{{agent}} didn't stop.", values),
  stopRefusedQuoted: (values) =>
    translate('session.failure.stopRefusedQuoted', "{{agent}} didn't stop: {{detail}}.", values),
  couldNotStop: (values) =>
    translate('session.failure.couldNotStop', "Couldn't stop {{agent}}.", values),
  couldNotStopTheAgent: (values) =>
    translate('session.failure.couldNotStopTheAgent', "Couldn't stop the agent.", values),
  noTurnToStop: (values) =>
    translate('session.failure.noTurnToStop', '{{agent}} had no turn running to stop.', values),
  backgroundTaskNotStopped: (values) =>
    translate(
      'session.failure.backgroundTaskNotStopped',
      "The background task wasn't stopped.",
      values
    ),
  backgroundTasksNotStopped: (values) =>
    translate(
      'session.failure.backgroundTasksNotStopped',
      "The background tasks weren't stopped.",
      values
    ),
  answerUnconfirmed: (values) =>
    translate(
      'session.failure.answerUnconfirmed',
      'Your answer was recorded but the agent did not confirm it.',
      values
    ),
  hostFault: (values) =>
    translate(
      'session.failure.hostFault',
      "Orca ran into a problem, so this didn't go through.",
      values
    ),
  hostFaultTryAgain: (values) =>
    translate(
      'session.failure.hostFaultTryAgain',
      "Orca ran into a problem, so this didn't go through. Try again.",
      values
    ),
  hostStopped: (values) =>
    translate(
      'session.failure.hostStopped',
      '{{agent}} never finished starting, so Orca stopped it.',
      values
    ),
  providerRateLimited: (values) =>
    translate(
      'session.failure.providerRateLimited',
      '{{agent}} is rate-limited and retrying.',
      values
    ),
  providerRetrying: (values) =>
    translate(
      'session.failure.providerRetrying',
      '{{agent}} hit a temporary problem and is retrying.',
      values
    ),
  providerRetryingQuoted: (values) =>
    translate(
      'session.failure.providerRetryingQuoted',
      '{{agent}} is retrying: {{detail}}.',
      values
    ),
  providerRetryNumber: (values) =>
    translate('session.failure.providerRetryNumber', 'Retry {{attempt}}.', values),
  providerRetryNumberOf: (values) =>
    translate(
      'session.failure.providerRetryNumberOf',
      'Retry {{attempt}} of {{maxRetries}}.',
      values
    ),
  providerRetryLastError: (values) =>
    translate('session.failure.providerRetryLastError', 'Last error: {{detail}}.', values),
  usageLimitReached: (values) =>
    translate('session.failure.usageLimitReached', '{{agent}} hit its usage limit.', values),
  usageLimitReachedNamed: (values) =>
    translate(
      'session.failure.usageLimitReachedNamed',
      '{{agent}} hit its {{window}} limit.',
      values
    ),
  usageLimitWindowSession: (values) =>
    translate('session.failure.usageLimitWindowSession', 'session', values),
  usageLimitWindowWeekly: (values) =>
    translate('session.failure.usageLimitWindowWeekly', 'weekly', values),
  usageLimitWindowWeeklyModel: (values) =>
    translate('session.failure.usageLimitWindowWeeklyModel', 'weekly model', values),
  usageLimitWindowCredits: (values) =>
    translate('session.failure.usageLimitWindowCredits', 'extra usage', values),
  usageLimitResetsAt: (values) =>
    translate('session.failure.usageLimitResetsAt', 'It resets at {{when}}.', values),
  usageLimitSendAfterReset: (values) =>
    translate(
      'session.failure.usageLimitSendAfterReset',
      'Send a message once it resets to continue.',
      values
    ),
  previousExitUnverifiable: (values) =>
    translate(
      'session.failure.previousExitUnverifiable',
      "Couldn't stop {{agent}} from before.",
      values
    ),
  sessionNotRestored: (values) =>
    translate(
      'session.failure.sessionNotRestored',
      "{{agent}} couldn't reopen its earlier session, so this chat continues in a new one. {{agent}} doesn't remember the earlier messages.",
      values
    )
}

export const sayMobileAgentSessionFailure: AgentSessionFailureSay = (id, values = {}) =>
  COPY[id](values)
