import { AGENT_SESSION_FAILURE_COPY } from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues
} from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import type { Translate } from '../../../i18n/mobile-i18n'

export function startFailureCopy(t: Translate) {
  return {
    savedConversationMissing: (values) =>
      t(
        'session.failure.savedConversationMissing',
        "{{agent}} couldn't find this chat's saved conversation.",
        values
      ),
    theAgent: (values) => t('session.failure.theAgent', 'The agent', values),
    providerStartFailed: (values) =>
      t(
        'session.failure.providerStartFailed',
        '{{agent}} stopped before it finished starting.',
        values
      ),
    runCommandAgain: (values) =>
      t('session.failure.runCommandAgain', 'Run /{{command}} again.', values),
    sendToTryAgain: (values) =>
      t('session.failure.sendToTryAgain', 'Send your message to try again.', values),
    sendAgainToTryOnceMore: (values) =>
      t(
        'session.failure.sendAgainToTryOnceMore',
        'Send your message again to try once more.',
        values
      ),
    couldNotStart: (values) =>
      t('session.failure.couldNotStart', "{{agent}} couldn't start.", values),
    couldNotRestart: (values) =>
      t('session.failure.couldNotRestart', "{{agent}} couldn't restart.", values),
    cliTooOld: (values) =>
      t(
        'session.failure.cliTooOld',
        '{{agent}} {{installedVersion}} is too old for chats. Update to {{minimumVersion}} or newer.',
        values
      ),
    startTimedOut: (values) =>
      t(
        'session.failure.startTimedOut',
        '{{agent}} took too long to start (no response to {{method}} after {{seconds}}s).',
        values
      ),
    startTimedOutKeepsHappening: (values) =>
      t(
        'session.failure.startTimedOutKeepsHappening',
        'If this keeps happening, the computer running this chat may be overloaded.',
        values
      ),
    argumentsUnsupportedOption: (values) =>
      t(
        'session.failure.argumentsUnsupportedOption',
        'Saved Arguments contain an unsupported option ({{option}}).',
        values
      ),
    argumentsMissingValue: (values) =>
      t(
        'session.failure.argumentsMissingValue',
        'Saved Arguments need a value for {{option}}.',
        values
      ),
    argumentsMultipleValues: (values) =>
      t(
        'session.failure.argumentsMultipleValues',
        'Saved Arguments give {{option}} more than one value.',
        values
      ),
    argumentsPositionalPrompt: (values) =>
      t('session.failure.argumentsPositionalPrompt', 'Saved Arguments include a prompt.', values),
    editSavedArguments: (values) =>
      t(
        'session.failure.editSavedArguments',
        'Edit them in Settings > Agents > Arguments.',
        values
      ),
    terminalAgentHoldsChat: (values) =>
      t(
        'session.failure.terminalAgentHoldsChat',
        'This chat is still open in a terminal agent.',
        values
      ),
    quitTerminalAgent: (values) =>
      t('session.failure.quitTerminalAgent', 'Quit that agent to continue the chat here.', values),
    startNewChat: (values) =>
      t('session.failure.startNewChat', 'Start a new chat to continue.', values),
    notSignedIn: (values) =>
      t('session.failure.notSignedIn', '{{agent}} is not signed in.', values),
    claudeSystemNotSignedIn: (values) =>
      t(
        'session.failure.claudeSystemNotSignedIn',
        "Claude isn't signed in. Run `{{loginCommand}}`, or choose an account in Claude Accounts settings.",
        values
      ),
    claudeManagedNotSignedIn: (values) =>
      t(
        'session.failure.claudeManagedNotSignedIn',
        "This Claude account isn't signed in. Sign in again in Claude Accounts settings.",
        values
      ),
    codexSystemNotSignedIn: (values) =>
      t(
        'session.failure.codexSystemNotSignedIn',
        "Codex isn't signed in. Run `{{loginCommand}}`.",
        values
      ),
    codexManagedNotSignedIn: (values) =>
      t(
        'session.failure.codexManagedNotSignedIn',
        "This Codex account isn't signed in. Sign in again in Codex Accounts settings.",
        values
      ),
    antigravityNotSignedIn: (values) =>
      t(
        'session.failure.antigravityNotSignedIn',
        "Antigravity isn't signed in. Sign in under Settings → Accounts → Antigravity. Then send your message again.",
        values
      ),
    antigravitySystemNotSignedIn: (values) =>
      t(
        'session.failure.antigravitySystemNotSignedIn',
        "Antigravity isn't signed in. Sign in by running `agy` on the computer running this chat, then send your message again.",
        values
      ),
    agentCommandNotSignedIn: (values) =>
      t(
        'session.failure.agentCommandNotSignedIn',
        'Sign in to {{agent}} with `{{loginCommand}}` on the computer running this chat.',
        values
      ),
    interactiveAgentNotSignedIn: (values) =>
      t(
        'session.failure.interactiveAgentNotSignedIn',
        'Sign in to {{agent}} by running `{{loginCommand}}` and using `{{slashCommand}}` on the computer running this chat.',
        values
      ),
    agentNotSignedIn: (values) =>
      t('session.failure.agentNotSignedIn', 'Sign in to {{agent}}.', values),
    cliMissing: (values) =>
      t(
        'session.failure.cliMissing',
        "{{agent}} wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents.",
        values
      ),
    cliMissingInWslDistro: (values) =>
      t(
        'session.failure.cliMissingInWslDistro',
        "{{agent}} isn't installed in the WSL distro {{distro}}. Install it inside {{distro}}, or check its Command in Settings → Agents.",
        values
      ),
    signInFirst: (values) => t('session.failure.signInFirst', 'Sign in first.', values),
    signInThenRunCommand: (values) =>
      t('session.failure.signInThenRunCommand', 'Sign in, then run /{{command}} again.', values),
    signInThenSend: (values) =>
      t('session.failure.signInThenSend', 'Sign in, then send your message again.', values),
    thenSendAgain: (values) =>
      t('session.failure.thenSendAgain', 'Then send your message again.', values),
    historyTooLarge: (values) =>
      t(
        'session.failure.historyTooLarge',
        "This conversation's history is too large to restore here.",
        values
      ),
    managedAccountEnvOverride: (values) =>
      t(
        'session.failure.managedAccountEnvOverride',
        'This Claude launch sets its own Anthropic sign-in variables. Remove them to use a managed Claude account.',
        values
      ),
    accountSwitchInProgress: (values) =>
      t(
        'session.failure.accountSwitchInProgress',
        "{{agent}}'s setup is changing on this host. Try again after it finishes.",
        values
      ),
    managedAccountUnsupported: (values) =>
      t(
        'session.failure.managedAccountUnsupported',
        'While a Claude account is added in WSL, Claude chats need a Windows Claude account.',
        values
      ),
    launchFolderMissing: (values) =>
      t(
        'session.failure.launchFolderMissing',
        'The folder this chat ran in no longer exists. Restore it to continue this chat.',
        values
      ),
    historyInOtherAccount: (values) =>
      t(
        'session.failure.historyInOtherAccount',
        "This chat's history is in another Claude account. Switch back to that account to continue it.",
        values
      ),
    claudeAccountFolderMissing: (values) =>
      t(
        'session.failure.claudeAccountFolderMissing',
        "The selected Claude account's folder is missing. Sign in to it again or choose another account.",
        values
      ),
    claudeAccountSetupFailed: (values) =>
      t(
        'session.failure.claudeAccountSetupFailed',
        'The selected Claude account could not be set up. Try again or choose another account.',
        values
      ),
    agentCommandNotRunnable: (values) =>
      t(
        'session.failure.agentCommandNotRunnable',
        "{{agent}}'s Command in Settings → Agents must be a program path or name Orca can find, with no arguments or variables. Change it or reset it.",
        values
      ),
    agentCommandFailed: (values) =>
      t(
        'session.failure.agentCommandFailed',
        "{{agent}}'s Command in Settings → Agents didn't start {{agent}}: {{detail}}. Change it or reset it.",
        values
      ),
    runtimeNotInstalled: (values) =>
      t(
        'session.failure.runtimeNotInstalled',
        "{{agent}} isn't installed on the computer running this chat. Install it from the chat in a current version of Orca.",
        values
      ),
    fullAccessAsRoot: (values) =>
      t(
        'session.failure.fullAccessAsRoot',
        "{{agent}} won't use Full access while it runs as root. Choose another permission for {{agent}} in Settings → Agents for the computer running this chat, then start a new chat.",
        values
      ),
    botToolsNeedStatusHooks: (values) =>
      t(
        'session.failure.botToolsNeedStatusHooks',
        AGENT_SESSION_FAILURE_COPY.botToolsNeedStatusHooks,
        values
      ),
    botToolsGatewayOutdated: (values) =>
      t(
        'session.failure.botToolsGatewayOutdated',
        AGENT_SESSION_FAILURE_COPY.botToolsGatewayOutdated,
        values
      ),
    launchPreparationFailed: (values) =>
      t(
        'session.failure.launchPreparationFailed',
        "Orca couldn't prepare {{agent}} to start on the computer running this chat.",
        values
      ),
    conversationOpenElsewhere: (values) =>
      t(
        'session.failure.conversationOpenElsewhere',
        'Codex is still holding this conversation open. Try again in a moment, or close other Codex terminals.',
        values
      ),
    conversationOpenInTerminal: (values) =>
      t(
        'session.failure.conversationOpenInTerminal',
        '{{agent}} is already running this conversation in another terminal. Quit {{agent}} there or close that terminal to continue here.',
        values
      ),
    chooseClaudeAccount: (values) =>
      t(
        'session.failure.chooseClaudeAccount',
        'Choose or add one in Claude Accounts settings.',
        values
      ),
    chooseClaudeAccountThenRunCommand: (values) =>
      t(
        'session.failure.chooseClaudeAccountThenRunCommand',
        'Choose or add one in Claude Accounts settings, then run /{{command}} again.',
        values
      ),
    chooseClaudeAccountThenSend: (values) =>
      t(
        'session.failure.chooseClaudeAccountThenSend',
        'Choose or add one in Claude Accounts settings, then send your message again.',
        values
      )
  } satisfies Partial<
    Record<AgentSessionFailureCopyId, (values: AgentSessionFailureCopyValues) => string>
  >
}
