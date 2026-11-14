import { AGENT_SESSION_FAILURE_COPY } from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues
} from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import { translate } from '../../../i18n/mobile-i18n'

export const START_FAILURE_COPY = {
  savedConversationMissing: (values) =>
    translate(
      'session.failure.savedConversationMissing',
      AGENT_SESSION_FAILURE_COPY.savedConversationMissing,
      values
    ),
  theAgent: (values) =>
    translate('session.failure.theAgent', AGENT_SESSION_FAILURE_COPY.theAgent, values),
  providerStartFailed: (values) =>
    translate(
      'session.failure.providerStartFailed',
      AGENT_SESSION_FAILURE_COPY.providerStartFailed,
      values
    ),
  runCommandAgain: (values) =>
    translate(
      'session.failure.runCommandAgain',
      AGENT_SESSION_FAILURE_COPY.runCommandAgain,
      values
    ),
  sendToTryAgain: (values) =>
    translate('session.failure.sendToTryAgain', AGENT_SESSION_FAILURE_COPY.sendToTryAgain, values),
  sendAgainToTryOnceMore: (values) =>
    translate(
      'session.failure.sendAgainToTryOnceMore',
      AGENT_SESSION_FAILURE_COPY.sendAgainToTryOnceMore,
      values
    ),
  couldNotStart: (values) =>
    translate('session.failure.couldNotStart', AGENT_SESSION_FAILURE_COPY.couldNotStart, values),
  couldNotRestart: (values) =>
    translate(
      'session.failure.couldNotRestart',
      AGENT_SESSION_FAILURE_COPY.couldNotRestart,
      values
    ),
  cliTooOld: (values) =>
    translate('session.failure.cliTooOld', AGENT_SESSION_FAILURE_COPY.cliTooOld, values),
  startTimedOut: (values) =>
    translate('session.failure.startTimedOut', AGENT_SESSION_FAILURE_COPY.startTimedOut, values),
  startTimedOutKeepsHappening: (values) =>
    translate(
      'session.failure.startTimedOutKeepsHappening',
      AGENT_SESSION_FAILURE_COPY.startTimedOutKeepsHappening,
      values
    ),
  argumentsUnsupportedOption: (values) =>
    translate(
      'session.failure.argumentsUnsupportedOption',
      AGENT_SESSION_FAILURE_COPY.argumentsUnsupportedOption,
      values
    ),
  argumentsMissingValue: (values) =>
    translate(
      'session.failure.argumentsMissingValue',
      AGENT_SESSION_FAILURE_COPY.argumentsMissingValue,
      values
    ),
  argumentsMultipleValues: (values) =>
    translate(
      'session.failure.argumentsMultipleValues',
      AGENT_SESSION_FAILURE_COPY.argumentsMultipleValues,
      values
    ),
  argumentsPositionalPrompt: (values) =>
    translate(
      'session.failure.argumentsPositionalPrompt',
      AGENT_SESSION_FAILURE_COPY.argumentsPositionalPrompt,
      values
    ),
  editSavedArguments: (values) =>
    translate(
      'session.failure.editSavedArguments',
      AGENT_SESSION_FAILURE_COPY.editSavedArguments,
      values
    ),
  terminalAgentHoldsChat: (values) =>
    translate(
      'session.failure.terminalAgentHoldsChat',
      'This chat is still open in a terminal agent.',
      values
    ),
  quitTerminalAgent: (values) =>
    translate(
      'session.failure.quitTerminalAgent',
      'Quit that agent to continue the chat here.',
      values
    ),
  startNewChat: (values) =>
    translate('session.failure.startNewChat', 'Start a new chat to continue.', values),
  notSignedIn: (values) =>
    translate('session.failure.notSignedIn', AGENT_SESSION_FAILURE_COPY.notSignedIn, values),
  claudeSystemNotSignedIn: (values) =>
    translate(
      'session.failure.claudeSystemNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.claudeSystemNotSignedIn,
      values
    ),
  claudeManagedNotSignedIn: (values) =>
    translate(
      'session.failure.claudeManagedNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.claudeManagedNotSignedIn,
      values
    ),
  codexSystemNotSignedIn: (values) =>
    translate(
      'session.failure.codexSystemNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.codexSystemNotSignedIn,
      values
    ),
  codexManagedNotSignedIn: (values) =>
    translate(
      'session.failure.codexManagedNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.codexManagedNotSignedIn,
      values
    ),
  antigravityNotSignedIn: (values) =>
    translate(
      'session.failure.antigravityNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.antigravityNotSignedIn,
      values
    ),
  antigravitySystemNotSignedIn: (values) =>
    translate(
      'session.failure.antigravitySystemNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.antigravitySystemNotSignedIn,
      values
    ),
  agentCommandNotSignedIn: (values) =>
    translate(
      'session.failure.agentCommandNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.agentCommandNotSignedIn,
      values
    ),
  interactiveAgentNotSignedIn: (values) =>
    translate(
      'session.failure.interactiveAgentNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.interactiveAgentNotSignedIn,
      values
    ),
  agentNotSignedIn: (values) =>
    translate(
      'session.failure.agentNotSignedIn',
      AGENT_SESSION_FAILURE_COPY.agentNotSignedIn,
      values
    ),
  cliMissing: (values) =>
    translate('session.failure.cliMissing', AGENT_SESSION_FAILURE_COPY.cliMissing, values),
  cliMissingInWslDistro: (values) =>
    translate(
      'session.failure.cliMissingInWslDistro',
      AGENT_SESSION_FAILURE_COPY.cliMissingInWslDistro,
      values
    ),
  signInFirst: (values) =>
    translate('session.failure.signInFirst', AGENT_SESSION_FAILURE_COPY.signInFirst, values),
  signInThenRunCommand: (values) =>
    translate(
      'session.failure.signInThenRunCommand',
      AGENT_SESSION_FAILURE_COPY.signInThenRunCommand,
      values
    ),
  signInThenSend: (values) =>
    translate('session.failure.signInThenSend', AGENT_SESSION_FAILURE_COPY.signInThenSend, values),
  thenSendAgain: (values) =>
    translate('session.failure.thenSendAgain', AGENT_SESSION_FAILURE_COPY.thenSendAgain, values),
  historyTooLarge: (values) =>
    translate(
      'session.failure.historyTooLarge',
      AGENT_SESSION_FAILURE_COPY.historyTooLarge,
      values
    ),
  managedAccountEnvOverride: (values) =>
    translate(
      'session.failure.managedAccountEnvOverride',
      AGENT_SESSION_FAILURE_COPY.managedAccountEnvOverride,
      values
    ),
  accountSwitchInProgress: (values) =>
    translate(
      'session.failure.accountSwitchInProgress',
      AGENT_SESSION_FAILURE_COPY.accountSwitchInProgress,
      values
    ),
  managedAccountUnsupported: (values) =>
    translate(
      'session.failure.managedAccountUnsupported',
      AGENT_SESSION_FAILURE_COPY.managedAccountUnsupported,
      values
    ),
  launchFolderMissing: (values) =>
    translate(
      'session.failure.launchFolderMissing',
      AGENT_SESSION_FAILURE_COPY.launchFolderMissing,
      values
    ),
  historyInOtherAccount: (values) =>
    translate(
      'session.failure.historyInOtherAccount',
      AGENT_SESSION_FAILURE_COPY.historyInOtherAccount,
      values
    ),
  claudeAccountFolderMissing: (values) =>
    translate(
      'session.failure.claudeAccountFolderMissing',
      "The selected Claude account's folder is missing. Sign in to it again or choose another account.",
      values
    ),
  claudeAccountSetupFailed: (values) =>
    translate(
      'session.failure.claudeAccountSetupFailed',
      'The selected Claude account could not be set up. Try again or choose another account.',
      values
    ),
  agentCommandNotRunnable: (values) =>
    translate(
      'session.failure.agentCommandNotRunnable',
      "{{agent}}'s Command in Settings → Agents must be a program path or name Orca can find, with no arguments or variables. Change it or reset it.",
      values
    ),
  runtimeNotInstalled: (values) =>
    translate(
      'session.failure.runtimeNotInstalled',
      AGENT_SESSION_FAILURE_COPY.runtimeNotInstalled,
      values
    ),
  fullAccessAsRoot: (values) =>
    translate(
      'session.failure.fullAccessAsRoot',
      AGENT_SESSION_FAILURE_COPY.fullAccessAsRoot,
      values
    ),
  launchPreparationFailed: (values) =>
    translate(
      'session.failure.launchPreparationFailed',
      AGENT_SESSION_FAILURE_COPY.launchPreparationFailed,
      values
    ),
  conversationOpenElsewhere: (values) =>
    translate(
      'session.failure.conversationOpenElsewhere',
      AGENT_SESSION_FAILURE_COPY.conversationOpenElsewhere,
      values
    ),
  conversationOpenInTerminal: (values) =>
    translate(
      'session.failure.conversationOpenInTerminal',
      AGENT_SESSION_FAILURE_COPY.conversationOpenInTerminal,
      values
    ),
  chooseClaudeAccount: (values) =>
    translate(
      'session.failure.chooseClaudeAccount',
      AGENT_SESSION_FAILURE_COPY.chooseClaudeAccount,
      values
    ),
  chooseClaudeAccountThenRunCommand: (values) =>
    translate(
      'session.failure.chooseClaudeAccountThenRunCommand',
      AGENT_SESSION_FAILURE_COPY.chooseClaudeAccountThenRunCommand,
      values
    ),
  chooseClaudeAccountThenSend: (values) =>
    translate(
      'session.failure.chooseClaudeAccountThenSend',
      AGENT_SESSION_FAILURE_COPY.chooseClaudeAccountThenSend,
      values
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
