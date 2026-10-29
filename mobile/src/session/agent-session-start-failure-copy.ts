import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues
} from '../../../src/shared/agent-session-failure-copy'
import { translate } from '../i18n/mobile-i18n'

export const START_FAILURE_COPY = {
  theAgent: (values) => translate('session.failure.theAgent', 'The agent', values),
  providerStartFailed: (values) =>
    translate(
      'session.failure.providerStartFailed',
      '{{agent}} stopped before it finished starting.',
      values
    ),
  runCommandAgain: (values) =>
    translate('session.failure.runCommandAgain', 'Run /{{command}} again.', values),
  sendToTryAgain: (values) =>
    translate('session.failure.sendToTryAgain', 'Send your message to try again.', values),
  sendAgainToTryOnceMore: (values) =>
    translate(
      'session.failure.sendAgainToTryOnceMore',
      'Send your message again to try once more.',
      values
    ),
  couldNotStart: (values) =>
    translate('session.failure.couldNotStart', "{{agent}} couldn't start.", values),
  couldNotRestart: (values) =>
    translate('session.failure.couldNotRestart', "{{agent}} couldn't restart.", values),
  cliTooOld: (values) =>
    translate(
      'session.failure.cliTooOld',
      '{{agent}} {{installedVersion}} is too old for chats. Update to {{minimumVersion}} or newer.',
      values
    ),
  startTimedOut: (values) =>
    translate(
      'session.failure.startTimedOut',
      '{{agent}} took too long to start (no response to {{method}} after {{seconds}}s).',
      values
    ),
  startTimedOutKeepsHappening: (values) =>
    translate(
      'session.failure.startTimedOutKeepsHappening',
      'If this keeps happening, the computer running this chat may be overloaded.',
      values
    ),
  argumentsUnsupportedOption: (values) =>
    translate(
      'session.failure.argumentsUnsupportedOption',
      'Saved Arguments contain an unsupported option ({{option}}).',
      values
    ),
  argumentsMissingValue: (values) =>
    translate(
      'session.failure.argumentsMissingValue',
      'Saved Arguments need a value for {{option}}.',
      values
    ),
  argumentsMultipleValues: (values) =>
    translate(
      'session.failure.argumentsMultipleValues',
      'Saved Arguments give {{option}} more than one value.',
      values
    ),
  argumentsPositionalPrompt: (values) =>
    translate(
      'session.failure.argumentsPositionalPrompt',
      'Saved Arguments include a prompt.',
      values
    ),
  editSavedArguments: (values) =>
    translate(
      'session.failure.editSavedArguments',
      'Edit them in Settings > Agents > Arguments.',
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
    translate('session.failure.notSignedIn', '{{agent}} is not signed in.', values),
  claudeSystemNotSignedIn: (values) =>
    translate(
      'session.failure.claudeSystemNotSignedIn',
      "Claude isn't signed in. Run `{{loginCommand}}`, or choose an account in Claude Accounts settings.",
      values
    ),
  claudeManagedNotSignedIn: (values) =>
    translate(
      'session.failure.claudeManagedNotSignedIn',
      "This Claude account isn't signed in. Sign in again in Claude Accounts settings.",
      values
    ),
  codexSystemNotSignedIn: (values) =>
    translate(
      'session.failure.codexSystemNotSignedIn',
      "Codex isn't signed in. Run `{{loginCommand}}`.",
      values
    ),
  codexManagedNotSignedIn: (values) =>
    translate(
      'session.failure.codexManagedNotSignedIn',
      "This Codex account isn't signed in. Sign in again in Codex Accounts settings.",
      values
    ),
  antigravityNotSignedIn: (values) =>
    translate(
      'session.failure.antigravityNotSignedIn',
      "Antigravity isn't signed in. Sign in under Settings → Accounts → Antigravity. Then send your message again.",
      values
    ),
  agentCommandNotSignedIn: (values) =>
    translate(
      'session.failure.agentCommandNotSignedIn',
      'Sign in to {{agent}} with `{{loginCommand}}` on the computer running this chat.',
      values
    ),
  interactiveAgentNotSignedIn: (values) =>
    translate(
      'session.failure.interactiveAgentNotSignedIn',
      'Sign in to {{agent}} by running `{{loginCommand}}` and using `{{slashCommand}}` on the computer running this chat.',
      values
    ),
  agentNotSignedIn: (values) =>
    translate('session.failure.agentNotSignedIn', 'Sign in to {{agent}}.', values),
  cliMissing: (values) =>
    translate(
      'session.failure.cliMissing',
      "{{agent}} wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents.",
      values
    ),
  cliMissingInWslDistro: (values) =>
    translate(
      'session.failure.cliMissingInWslDistro',
      "{{agent}} isn't installed in the WSL distro {{distro}}. Install it inside {{distro}}, or check its Command in Settings → Agents.",
      values
    ),
  signInFirst: (values) => translate('session.failure.signInFirst', 'Sign in first.', values),
  signInThenRunCommand: (values) =>
    translate(
      'session.failure.signInThenRunCommand',
      'Sign in, then run /{{command}} again.',
      values
    ),
  signInThenSend: (values) =>
    translate('session.failure.signInThenSend', 'Sign in, then send your message again.', values),
  thenSendAgain: (values) =>
    translate('session.failure.thenSendAgain', 'Then send your message again.', values),
  historyTooLarge: (values) =>
    translate(
      'session.failure.historyTooLarge',
      "This conversation's history is too large to restore here.",
      values
    ),
  managedAccountEnvOverride: (values) =>
    translate(
      'session.failure.managedAccountEnvOverride',
      'This Claude launch sets its own Anthropic sign-in variables. Remove them to use a managed Claude account.',
      values
    ),
  accountSwitchInProgress: (values) =>
    translate(
      'session.failure.accountSwitchInProgress',
      "{{agent}}'s setup is changing on this host. Try again after it finishes.",
      values
    ),
  managedAccountUnsupported: (values) =>
    translate(
      'session.failure.managedAccountUnsupported',
      'While a Claude account is added in WSL, Claude chats need a Windows Claude account.',
      values
    ),
  launchFolderMissing: (values) =>
    translate(
      'session.failure.launchFolderMissing',
      'The folder this chat ran in no longer exists. Restore it to continue this chat.',
      values
    ),
  historyInOtherAccount: (values) =>
    translate(
      'session.failure.historyInOtherAccount',
      "This chat's history is in another Claude account. Switch back to that account to continue it.",
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
      "{{agent}} isn't installed on the computer running this chat. Install it from the chat in a current version of Orca.",
      values
    ),
  fullAccessAsRoot: (values) =>
    translate(
      'session.failure.fullAccessAsRoot',
      "{{agent}} won't use Full access while it runs as root. Choose another permission for {{agent}} in Settings → Agents for the computer running this chat, then start a new chat.",
      values
    ),
  launchPreparationFailed: (values) =>
    translate(
      'session.failure.launchPreparationFailed',
      "Orca couldn't prepare {{agent}} to start on the computer running this chat.",
      values
    ),
  conversationOpenElsewhere: (values) =>
    translate(
      'session.failure.conversationOpenElsewhere',
      'Codex is still holding this conversation open. Try again in a moment, or close other Codex terminals.',
      values
    ),
  conversationOpenInTerminal: (values) =>
    translate(
      'session.failure.conversationOpenInTerminal',
      '{{agent}} is already running this conversation in another terminal. Quit {{agent}} there or close that terminal to continue here.',
      values
    ),
  chooseClaudeAccount: (values) =>
    translate(
      'session.failure.chooseClaudeAccount',
      'Choose or add one in Claude Accounts settings.',
      values
    ),
  chooseClaudeAccountThenRunCommand: (values) =>
    translate(
      'session.failure.chooseClaudeAccountThenRunCommand',
      'Choose or add one in Claude Accounts settings, then run /{{command}} again.',
      values
    ),
  chooseClaudeAccountThenSend: (values) =>
    translate(
      'session.failure.chooseClaudeAccountThenSend',
      'Choose or add one in Claude Accounts settings, then send your message again.',
      values
    )
} satisfies Partial<
  Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
>
