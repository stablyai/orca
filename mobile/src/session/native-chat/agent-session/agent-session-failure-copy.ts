import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues,
  AgentSessionFailureSay
} from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import { translate, type Translate } from '../../../i18n/mobile-i18n'
import { AGENT_SESSION_FAILURE_COPY } from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import { startFailureCopy } from './agent-session-start-failure-copy'
import { sendFailureCopy } from './agent-session-send-failure-copy'

export function mobileAgentSessionFailureSay(t: Translate): AgentSessionFailureSay {
  const copy: Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string> =
    {
      ...startFailureCopy(t),
      forkOriginalMissing: (values) =>
        t(
          'session.failure.forkOriginalMissing',
          AGENT_SESSION_FAILURE_COPY.forkOriginalMissing,
          values
        ),
      forkOriginalUnavailable: (values) =>
        t(
          'session.failure.forkOriginalUnavailable',
          AGENT_SESSION_FAILURE_COPY.forkOriginalUnavailable,
          values
        ),
      forkOriginalMissingNamed: (values) =>
        t(
          'session.failure.forkOriginalMissingNamed',
          AGENT_SESSION_FAILURE_COPY.forkOriginalMissingNamed,
          values
        ),
      forkOriginalUnavailableNamed: (values) =>
        t(
          'session.failure.forkOriginalUnavailableNamed',
          AGENT_SESSION_FAILURE_COPY.forkOriginalUnavailableNamed,
          values
        ),
      forkOriginalLatestOnly: (values) =>
        t(
          'session.failure.forkOriginalLatestOnly',
          AGENT_SESSION_FAILURE_COPY.forkOriginalLatestOnly,
          values
        ),
      forkOriginalLatestOnlyNamed: (values) =>
        t(
          'session.failure.forkOriginalLatestOnlyNamed',
          AGENT_SESSION_FAILURE_COPY.forkOriginalLatestOnlyNamed,
          values
        ),
      pluginInputRequired: (values) =>
        t(
          'session.failure.pluginInputRequired',
          AGENT_SESSION_FAILURE_COPY.pluginInputRequired,
          values
        ),
      ...sendFailureCopy(t),
      backgroundTasksRunning: (values) =>
        t('session.failure.backgroundTasksRunning', 'Background tasks are still running.', values),
      waitForBackgroundTasks: (values) =>
        t(
          'session.failure.waitForBackgroundTasks',
          'Wait for the background tasks to finish.',
          values
        ),
      agentStarting: (values) =>
        t('session.failure.agentStarting', 'The agent is still starting.', values),
      waitForStart: (values) =>
        t('session.failure.waitForStart', 'Wait for the agent to finish starting.', values),
      agentStillWorking: (values) =>
        t('session.failure.agentStillWorking', 'The agent is still working.', values),
      runCommandWhenDone: (values) =>
        t('session.failure.runCommandWhenDone', "Run /{{command}} when it's done.", values),
      commandAfterAnswer: (values) =>
        t(
          'session.failure.commandAfterAnswer',
          "Answer the agent's question or approval, then run /{{command}}.",
          values
        ),
      compactionFailed: (values) =>
        t('session.failure.compactionFailed', 'Compaction failed.', values),
      compactionFailedQuoted: (values) =>
        t('session.failure.compactionFailedQuoted', 'Compaction failed: {{detail}}.', values),
      compactionUnconfirmed: (values) =>
        t('session.failure.compactionUnconfirmed', 'Compaction completion is unconfirmed.', values),
      cancelUnconfirmed: (values) =>
        t('session.failure.cancelUnconfirmed', 'Cancellation was not confirmed.', values),
      stopRefused: (values) => t('session.failure.stopRefused', "{{agent}} didn't stop.", values),
      stopRefusedQuoted: (values) =>
        t('session.failure.stopRefusedQuoted', "{{agent}} didn't stop: {{detail}}.", values),
      couldNotStop: (values) =>
        t('session.failure.couldNotStop', "Couldn't stop {{agent}}.", values),
      couldNotStopTheAgent: (values) =>
        t('session.failure.couldNotStopTheAgent', "Couldn't stop the agent.", values),
      noTurnToStop: (values) =>
        t('session.failure.noTurnToStop', '{{agent}} had no turn running to stop.', values),
      backgroundTaskNotStopped: (values) =>
        t(
          'session.failure.backgroundTaskNotStopped',
          "The background task wasn't stopped.",
          values
        ),
      backgroundTasksNotStopped: (values) =>
        t(
          'session.failure.backgroundTasksNotStopped',
          "The background tasks weren't stopped.",
          values
        ),
      answerUnconfirmed: (values) =>
        t(
          'session.failure.answerUnconfirmed',
          'Your answer was recorded but the agent did not confirm it.',
          values
        ),
      hostFault: (values) =>
        t(
          'session.failure.hostFault',
          "Orca ran into a problem, so this didn't go through.",
          values
        ),
      hostFaultTryAgain: (values) =>
        t(
          'session.failure.hostFaultTryAgain',
          "Orca ran into a problem, so this didn't go through. Try again.",
          values
        ),
      hostStopped: (values) =>
        t(
          'session.failure.hostStopped',
          '{{agent}} never finished starting, so Orca stopped it.',
          values
        ),
      providerRateLimited: (values) =>
        t('session.failure.providerRateLimited', '{{agent}} is rate-limited and retrying.', values),
      providerRetrying: (values) =>
        t(
          'session.failure.providerRetrying',
          '{{agent}} hit a temporary problem and is retrying.',
          values
        ),
      providerRetryingQuoted: (values) =>
        t('session.failure.providerRetryingQuoted', '{{agent}} is retrying: {{detail}}.', values),
      providerRetryNumber: (values) =>
        t('session.failure.providerRetryNumber', 'Retry {{attempt}}.', values),
      providerRetryNumberOf: (values) =>
        t('session.failure.providerRetryNumberOf', 'Retry {{attempt}} of {{maxRetries}}.', values),
      providerRetryLastError: (values) =>
        t('session.failure.providerRetryLastError', 'Last error: {{detail}}.', values),
      usageLimitReached: (values) =>
        t('session.failure.usageLimitReached', '{{agent}} hit its usage limit.', values),
      usageLimitReachedNamed: (values) =>
        t('session.failure.usageLimitReachedNamed', '{{agent}} hit its {{window}} limit.', values),
      usageLimitWindowSession: (values) =>
        t('session.failure.usageLimitWindowSession', 'session', values),
      usageLimitWindowWeekly: (values) =>
        t('session.failure.usageLimitWindowWeekly', 'weekly', values),
      usageLimitWindowWeeklyModel: (values) =>
        t('session.failure.usageLimitWindowWeeklyModel', 'weekly model', values),
      usageLimitWindowCredits: (values) =>
        t('session.failure.usageLimitWindowCredits', 'extra usage', values),
      usageLimitResetsAt: (values) =>
        t('session.failure.usageLimitResetsAt', 'It resets at {{when}}.', values),
      usageLimitSendAfterReset: (values) =>
        t(
          'session.failure.usageLimitSendAfterReset',
          'Send a message once it resets to continue.',
          values
        ),
      previousExitUnverifiable: (values) =>
        t(
          'session.failure.previousExitUnverifiable',
          "Couldn't stop {{agent}} from before.",
          values
        ),
      sessionNotRestored: (values) =>
        t(
          'session.failure.sessionNotRestored',
          "{{agent}} couldn't reopen its earlier session, so this chat continues in a new one. {{agent}} doesn't remember the earlier messages.",
          values
        )
    }
  return (id, values = {}) => copy[id](values)
}

export const sayMobileAgentSessionFailure: AgentSessionFailureSay =
  mobileAgentSessionFailureSay(translate)
