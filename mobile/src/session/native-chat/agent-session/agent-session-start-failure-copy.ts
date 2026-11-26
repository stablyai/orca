import { AGENT_SESSION_FAILURE_COPY } from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import type {
  AgentSessionFailureCopyId,
  AgentSessionFailureCopyValues
} from '../../../../../src/shared/agent-session/failures/agent-session-failure-copy'
import { translate } from '../../../i18n/mobile-i18n'

const SHARED_START_FAILURE_IDS = [
  'instructionNotSent',
  'instructionPending',
  'instructionCommit',
  'instructionUpdate',
  'instructionUnknown',
  'savedConversationMissing',
  'theAgent',
  'providerStartFailed',
  'runCommandAgain',
  'sendToTryAgain',
  'sendAgainToTryOnceMore',
  'couldNotStart',
  'couldNotRestart',
  'startTimedOut',
  'startTimedOutKeepsHappening',
  'argumentsUnsupportedOption',
  'argumentsMissingValue',
  'argumentsMultipleValues',
  'argumentsPositionalPrompt',
  'editSavedArguments',
  'terminalAgentHoldsChat',
  'quitTerminalAgent',
  'startNewChat',
  'notSignedIn',
  'claudeSystemNotSignedIn',
  'claudeManagedNotSignedIn',
  'codexSystemNotSignedIn',
  'codexManagedNotSignedIn',
  'antigravityNotSignedIn',
  'antigravitySystemNotSignedIn',
  'agentCommandNotSignedIn',
  'interactiveAgentNotSignedIn',
  'agentNotSignedIn',
  'cliMissing',
  'cliMissingInWslDistro',
  'signInFirst',
  'signInThenRunCommand',
  'signInThenSend',
  'thenSendAgain',
  'historyTooLarge',
  'managedAccountEnvOverride',
  'accountSwitchInProgress',
  'managedAccountUnsupported',
  'launchFolderMissing',
  'historyInOtherAccount',
  'claudeAccountFolderMissing',
  'claudeAccountSetupFailed',
  'agentCommandFailed',
  'runtimeNotInstalled',
  'fullAccessAsRoot',
  'botToolsNeedStatusHooks',
  'botToolsGatewayOutdated',
  'launchPreparationFailed',
  'conversationOpenElsewhere',
  'conversationOpenInTerminal',
  'chooseClaudeAccount',
  'chooseClaudeAccountThenRunCommand',
  'chooseClaudeAccountThenSend'
] as const satisfies readonly AgentSessionFailureCopyId[]

type SharedStartFailureId = (typeof SHARED_START_FAILURE_IDS)[number]
type StartFailureCopy = (values: AgentSessionFailureCopyValues) => string

// Each listed ID produces one entry. The mobile catalog declares these computed keys.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each listed ID becomes one entry with a translator.
const sharedCopy = Object.fromEntries(
  SHARED_START_FAILURE_IDS.map((id) => [
    id,
    (values: AgentSessionFailureCopyValues) =>
      translate(`session.failure.${id}`, AGENT_SESSION_FAILURE_COPY[id], values)
  ])
) as Record<SharedStartFailureId, StartFailureCopy>

export const START_FAILURE_COPY = {
  ...sharedCopy,
  cliTooOld: (values) =>
    translate(
      'session.failure.cliTooOld',
      '{{agent}} {{installedVersion}} is too old for chats. Update to {{minimumVersion}} or newer.',
      values
    ),
  agentCommandNotRunnable: (values) =>
    translate(
      'session.failure.agentCommandNotRunnable',
      "{{agent}}'s Command in Settings → Agents must be a program path or name Orca can find, with no arguments or variables. Change it or reset it.",
      values
    )
} satisfies Partial<Record<AgentSessionFailureCopyId, StartFailureCopy>>
