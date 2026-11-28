import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  getTuiAgentDetectCommands,
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { AGENT_LAUNCH_CHOICE_KEYS } from '../../../../../../../shared/agent-launch/choices/agent-launch-choices'
import { reconcileAgentChoiceArgsDetailed } from '../../../../../../../shared/agent-launch/choices/agent-choice-reconciliation'
import {
  findAgentExecutableIndex,
  isAgentExecutableToken
} from '../../../../../../../shared/agent-launch/startup/agent-executable-args'
import {
  resolveStartupShell,
  tokenizeStartupCommand
} from '../../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { SleepingAgentLaunchConfig } from '../../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentSessionExecutionOptions } from '../../../../../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { OrcaRuntimeService } from '../../../../../orca-runtime'
import { resolveDispatchAssigneeParty } from '../../../../../orchestration/addressing/orchestration-party'
import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type {
  OrchestrationWorkerLaunchReceipt,
  WorkerLaunchSettingSource
} from '../start/launch/worker-launch-preferences'
import type { WorkerStartInput } from '../start/worker-start-input'
import type { WorkerFollowUpPlacement } from './worker-follow-up-choice'
import type { WorkerFollowUp } from './worker-follow-up-placement'

function nonEmptySetting(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/** Open terminals and user tabs keep their agent from session observation; model and effort cannot be observed reliably. */
export function openTerminalLaunchReceipt(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  fallbackAgent: string | undefined,
  terminalHandle: string,
  sessionAgent?: string
): OrchestrationWorkerLaunchReceipt {
  const live = runtime.orchestrationSenderNames.liveAgentOf(
    resolveDispatchAssigneeParty(terminalHandle, db)
  )
  const observedAgent = isTuiAgent(live) ? live : isTuiAgent(sessionAgent) ? sessionAgent : null
  const inheritedAgent = isTuiAgent(fallbackAgent) ? fallbackAgent : null
  return {
    requested: { agent: null, model: null, effort: null },
    effective: { agent: observedAgent ?? inheritedAgent, model: null, effort: null },
    effectiveSource: {
      agent: observedAgent ? 'session' : inheritedAgent ? 'inherited' : 'unavailable',
      model: 'unavailable',
      effort: 'unavailable'
    }
  }
}

const POSIX_ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function isTrustedCommandPrefix(
  prefixTokens: readonly string[],
  shell: ReturnType<typeof resolveStartupShell>
): boolean {
  if (shell === 'posix') {
    return prefixTokens.every((token) => POSIX_ENV_ASSIGNMENT.test(token))
  }
  return (
    prefixTokens.length === 0 ||
    (shell === 'powershell' && prefixTokens.length === 1 && prefixTokens[0] === '&')
  )
}

function defaultLaunchHeadTrailingLength(
  agent: TuiAgent,
  shell: ReturnType<typeof resolveStartupShell>,
  tokensAfterExec: readonly string[]
): number {
  const launchHead = tokenizeStartupCommand(TUI_AGENT_CONFIG[agent].launchCmd, shell)
  if (!launchHead.ok || launchHead.tokens.length <= 1) {
    return 0
  }
  const trailing = launchHead.tokens.slice(1)
  if (trailing.length > tokensAfterExec.length) {
    return 0
  }
  return trailing.every((token, index) => tokensAfterExec[index] === token) ? trailing.length : 0
}

function extractRecipeAgentArgs(
  agent: TuiAgent,
  recipe: SleepingAgentLaunchConfig
): string | undefined {
  if (recipe.ompResumeFilePath) {
    return undefined
  }
  const command = nonEmptySetting(recipe.agentCommand)
  if (!command) {
    return nonEmptySetting(recipe.agentArgs) ?? undefined
  }
  // Resume replays agentCommand and ignores agentArgs, so never fall back to recipe.agentArgs here.
  const shell = resolveStartupShell(process.platform)
  if (/[\r\n`|;<>]/.test(command) || (shell !== 'powershell' && command.includes('&'))) {
    return undefined
  }
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok || tokenized.spans.some((span) => span.divergesFromShell)) {
    return undefined
  }
  const detectNames = getTuiAgentDetectCommands(TUI_AGENT_CONFIG[agent])
  const execIndex = findAgentExecutableIndex(tokenized.tokens, shell, (token) =>
    isAgentExecutableToken(token, detectNames)
  )
  if (execIndex < 0 || !isTrustedCommandPrefix(tokenized.tokens.slice(0, execIndex), shell)) {
    return undefined
  }
  const trailingHeadLength = defaultLaunchHeadTrailingLength(
    agent,
    shell,
    tokenized.tokens.slice(execIndex + 1)
  )
  const argsIndex = execIndex + 1 + trailingHeadLength
  if (argsIndex >= tokenized.spans.length) {
    return undefined
  }
  const argsSlice = nonEmptySetting(command.slice(tokenized.spans[argsIndex].start))
  return argsSlice && !argsSlice.includes('&') ? argsSlice : undefined
}

const SHELL_EXPANSION_CHARS = /[$`*?[\]{}]/

function literalRecipeSetting(
  value: string | null | undefined,
  fromAgentCommand: boolean
): string | null {
  const trimmed = nonEmptySetting(value)
  if (!trimmed) {
    return null
  }
  // Values replayed through a shell are not literal when they carry variable/command/glob/tilde syntax.
  if (fromAgentCommand && (SHELL_EXPANSION_CHARS.test(trimmed) || trimmed.startsWith('~'))) {
    return null
  }
  return trimmed
}

/** Derive effective settings only from the resume recipe actually passed to resumeAgentSessionInWorkspace. */
export function reopenedTerminalLaunchReceipt(
  agent: TuiAgent,
  hadLaunchConfig: boolean,
  recipe: SleepingAgentLaunchConfig
): OrchestrationWorkerLaunchReceipt {
  const userArgs = hadLaunchConfig ? extractRecipeAgentArgs(agent, recipe) : undefined
  const parsed = userArgs
    ? reconcileAgentChoiceArgsDetailed({
        agent,
        userArgs,
        choices: {},
        mode: 'load',
        keys: AGENT_LAUNCH_CHOICE_KEYS
      }).sourceChoices
    : undefined
  const fromAgentCommand = Boolean(nonEmptySetting(recipe.agentCommand))
  const model = literalRecipeSetting(parsed?.model, fromAgentCommand)
  const effort = literalRecipeSetting(parsed?.options?.effort, fromAgentCommand)
  return {
    requested: { agent: null, model: null, effort: null },
    effective: { agent, model, effort },
    effectiveSource: {
      agent: 'session',
      model: model ? 'inherited' : 'unavailable',
      effort: effort ? 'inherited' : 'unavailable'
    }
  }
}

/**
 * Build effective launch provenance from the options snapshot actually captured at structured send admission.
 * `'session'` here records the settings selected when sending this turn; whether the provider applied them is unconfirmed.
 */
export function structuredDeliveryLaunchReceipt(args: {
  observedAgent: TuiAgent | null
  fallbackAgent?: string | null
  capturedOptions?: AgentSessionExecutionOptions
}): OrchestrationWorkerLaunchReceipt {
  const inheritedAgent = isTuiAgent(args.fallbackAgent) ? args.fallbackAgent : null
  const agent = args.observedAgent ?? inheritedAgent
  const options = args.capturedOptions
  const model = options ? nonEmptySetting(options.model) : null
  const effort = options ? nonEmptySetting(options.effort) : null
  return {
    requested: { agent: null, model: null, effort: null },
    effective: { agent, model, effort },
    effectiveSource: {
      agent: args.observedAgent ? 'session' : inheritedAgent ? 'inherited' : 'unavailable',
      model: options ? (model ? 'session' : 'default') : 'unavailable',
      effort: options ? (effort ? 'session' : 'default') : 'unavailable'
    }
  }
}

/** Attach provenance for a fresh-start follow-up from the actual launch receipt and inherited/session sources. */
export function startedFreshFollowUpLaunchReceipt(
  receipt: OrchestrationWorkerLaunchReceipt,
  params: { agent?: string; model?: string; effort?: string },
  sessionOptions?: Readonly<Record<string, string>>,
  sessionAgent?: string
): OrchestrationWorkerLaunchReceipt {
  const agentSource: WorkerLaunchSettingSource = !receipt.effective?.agent
    ? 'unavailable'
    : sessionAgent
      ? 'session'
      : params.agent
        ? 'inherited'
        : 'unavailable'
  // Fresh terminal starts resolve agentLaunchChoices inside createTerminal without returning them across RuntimeTerminalCreate; never emit null + default.
  const optionSource = (
    effectiveValue: string | null | undefined,
    inherited: string | undefined,
    sessionValue: string | undefined
  ): WorkerLaunchSettingSource =>
    !nonEmptySetting(effectiveValue)
      ? 'unavailable'
      : inherited
        ? 'inherited'
        : sessionValue
          ? 'session'
          : 'unavailable'
  return {
    ...receipt,
    effectiveSource: {
      agent: agentSource,
      model: optionSource(receipt.effective?.model, params.model, sessionOptions?.model),
      effort: optionSource(receipt.effective?.effort, params.effort, sessionOptions?.effort)
    }
  }
}

/** Merge resolved follow-up placement into WorkerStartInput and carry launch provenance on followUp. */
export function applyFollowUpPlacement(
  params: WorkerStartInput,
  followUp: WorkerFollowUp,
  placement: WorkerFollowUpPlacement
): { params: WorkerStartInput; followUp: WorkerFollowUp; spec: string } {
  const { delivery, worktreeId, reopen, retainedChat, earlierWork, launchReceipt, ...launch } =
    placement
  const spec = [params.spec, delivery === 'started_fresh' ? earlierWork : undefined]
    .filter(Boolean)
    .join('\n\n')
  return {
    spec,
    params: { ...params, worktree: `id:${worktreeId}`, ...launch, spec },
    followUp: {
      ...followUp,
      reopen,
      retainedChat,
      earlierWork,
      ...(launchReceipt ? { launchReceipt } : {})
    }
  }
}
