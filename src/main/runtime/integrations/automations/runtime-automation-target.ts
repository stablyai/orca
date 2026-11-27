import type {
  Automation,
  AutomationBotTarget,
  AutomationWorkspaceMode
} from '../../../../shared/automations/automation-definition'
import type { Bot } from '../../../../shared/bot-types'
import { assertHostBotsEnabled } from '../../../bots/bot-team-policy'
import type { Repo } from '../../../../shared/repository/repo-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { hasExtraAgentArgs } from '../../../../shared/agent-launch/startup/automation-extra-agent-args'
import {
  THREAD_REPLIES_UNSUPPORTED,
  type AutomationEventTrigger
} from '../../../../shared/automation-event-triggers'
import { botEventTriggerRefusal } from '../../../../shared/bot-event-sources'
import {
  botAutomationSetup,
  chatRunAgentSetupRefusal
} from '../../../../shared/bots/bot-agent-setup'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { hostQualifiedRepoSelector } from '../../workspaces/catalog/runtime-repo-selector'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type {
  RuntimeAutomationTargetInput,
  RuntimeAutomationTargetResolvers
} from './runtime-automation-run-context'

export type { RuntimeAutomationTargetResolvers }

export type RuntimeAutomationTarget = {
  projectId: string
  workspaceMode: AutomationWorkspaceMode
  workspaceId?: string | null
  repo: Repo | null
}

export async function resolveRuntimeAutomationTarget(
  resolvers: RuntimeAutomationTargetResolvers,
  input: RuntimeAutomationTargetInput,
  current?: Automation
): Promise<RuntimeAutomationTarget> {
  const hasRepo = input.repo !== undefined
  const hasWorkspace = input.workspace !== undefined
  if (
    current?.workspaceMode === 'existing' &&
    hasRepo &&
    !hasWorkspace &&
    input.workspaceMode !== 'new_per_run'
  ) {
    throw new Error(
      'Repo updates for existing-workspace automation require workspaceMode new_per_run.'
    )
  }
  const contextHost = parseExecutionHostId(
    input.runContext?.hostId ??
      (!input.repo && !input.workspace ? current?.runContext?.hostId : undefined)
  )
  const hostId = contextHost?.kind === 'runtime' ? 'local' : contextHost?.id
  const workspace = input.workspace
    ? await resolvers.showManagedWorktree(input.workspace, hostId)
    : null
  const repoSelector =
    input.repo ??
    (workspace?.repoId
      ? `id:${workspace.repoId}`
      : current?.projectId
        ? `id:${current.projectId}`
        : null)
  const repo = repoSelector
    ? await resolvers.showRepo(hostQualifiedRepoSelector(repoSelector, hostId ?? workspace?.hostId))
    : null
  const workspaceMode =
    input.workspaceMode ??
    (workspace
      ? 'existing'
      : input.repo && !current
        ? 'new_per_run'
        : (current?.workspaceMode ?? 'new_per_run'))
  if (workspaceMode === 'existing') {
    const workspaceId = workspace?.id ?? current?.workspaceId
    const projectId = workspace?.repoId ?? current?.projectId
    if (repo && repo.id !== projectId) {
      throw new Error('Selected workspace belongs to a different repo.')
    }
    if (!workspaceId || !projectId) {
      throw new Error('Existing-workspace automation requires --workspace.')
    }
    return { projectId, workspaceMode, workspaceId, repo }
  }
  const projectId = repo?.id ?? workspace?.repoId ?? current?.projectId
  if (!projectId) {
    throw new Error('Automation requires --repo or --workspace.')
  }
  return { projectId, workspaceMode: 'new_per_run', workspaceId: null, repo }
}

export function requireAutomationBot(store: RuntimeStore | null, target: AutomationBotTarget): Bot {
  // Every client creates or retargets an automation to a bot through here.
  assertHostBotsEnabled(store?.getSettings())
  const bot = store?.getBots?.().find((entry) => entry.id === target.botId)
  if (!bot) {
    throw new Error('bot_not_found')
  }
  return bot
}

/** Again at the write: a bot deleted while a save awaited its lookups must not get the automation. */
export function assertAutomationBotAtWrite(
  store: RuntimeStore | null,
  target: AutomationBotTarget | null | undefined
): void {
  if (target) {
    requireAutomationBot(store, target)
  }
}

/** A bot has no project: runs go to its folder, and re-resolve it and the agent from the bot. */
export function botAutomationTarget(bot: Bot): RuntimeAutomationTarget {
  return {
    projectId: '',
    workspaceMode: 'existing',
    workspaceId: folderWorkspaceKey(bot.folderWorkspaceId),
    repo: null
  }
}

type BotOwnedSettings = {
  agentId?: string
  extraAgentArgs?: string
  reuseSession?: boolean
  runContext?: unknown
  sourceContext?: unknown
  repo?: string
  workspace?: string
  workspaceMode?: string
}

/** The agent a bot automation's runs start on, as its record keeps it; refused when the target
 *  continues a chat, which stays on that chat's agent. */
export function botAutomationAgent(
  target: AutomationBotTarget | undefined,
  bot: Pick<Bot, 'agent' | 'launch'>
): Bot['agent'] {
  if (target?.agentSetup && target.runsIn !== 'new') {
    throw new Error(chatRunAgentSetupRefusal())
  }
  return target ? botAutomationSetup(target, bot).agent : bot.agent
}

/** The bot supplies the agent, session and place to run, so these would be saved but never used. */
export function assertNoBotOwnedSettings(input: BotOwnedSettings, botAgent: string): void {
  if (
    (input.agentId !== undefined && input.agentId !== botAgent) ||
    hasExtraAgentArgs(input.extraAgentArgs) ||
    input.reuseSession ||
    input.runContext ||
    input.sourceContext ||
    input.repo !== undefined ||
    input.workspace !== undefined ||
    (input.workspaceMode !== undefined && input.workspaceMode !== 'existing')
  ) {
    throw new Error("A bot automation runs with the bot's own agent, session and folder.")
  }
}

/** A rule from a source the bot has no connector for would be saved and never fire. */
export function assertBotHearsEventTriggers(
  bot: Bot,
  on: readonly AutomationEventTrigger[] | undefined
): void {
  const refusal = botEventTriggerRefusal(bot, on ?? [])
  if (refusal) {
    throw new Error(refusal)
  }
}

/** A rule an older cloud reads without its thread would lose every final post, so it is never saved. */
export function assertThreadReplies(
  takesThreadReplies: () => boolean,
  next: AutomationBotTarget | undefined,
  current?: Pick<Automation, 'bot'>
): void {
  if (
    next?.resultsTo === 'thread' &&
    current?.bot?.resultsTo !== 'thread' &&
    !takesThreadReplies()
  ) {
    throw new Error(THREAD_REPLIES_UNSUPPORTED)
  }
}

/** The bot a new automation targets, once its own settings and event rules pass; null for a project's. */
export function requireCreatableAutomationBot(
  store: RuntimeStore | null,
  input: BotOwnedSettings & { bot?: AutomationBotTarget; on?: readonly AutomationEventTrigger[] },
  webhooks: { hearing(bot: Bot): Bot }
): Bot | null {
  if (!input.bot) {
    return null
  }
  const bot = requireAutomationBot(store, input.bot)
  const agent = botAutomationAgent(input.bot, bot)
  assertNoBotOwnedSettings(input, agent)
  assertBotHearsEventTriggers(webhooks.hearing(bot), input.on)
  return bot
}

/** One of a bot's chats that takes mail, by its id from `orca bot chats`; null when it is gone. */
export type BotChatLookup = (bot: Bot, id: string) => Promise<{ title: string | null } | null>

export function botChatGone(botName: string, id: string): string {
  return `${botName} has no chat chat:${id} that takes mail, so pick one that \`orca bot chats --bot "${botName}"\` lists.`
}

/** A target that runs in a chosen chat, once that is one of the bot's chats that takes mail; saved
 *  with its title. An edit that keeps the saved chat is not checked again; one to new conversations drops it. */
export async function withCheckedBotChat(
  target: AutomationBotTarget | undefined,
  bot: Bot | null | undefined,
  lookup: BotChatLookup,
  saved?: AutomationBotTarget
): Promise<AutomationBotTarget | undefined> {
  if (target?.chat && target.runsIn !== 'chat') {
    // A run in a new conversation each time names no chat.
    const rest = { ...target }
    delete rest.chat
    return rest
  }
  if (!target?.chat) {
    return target
  }
  if (saved?.chat && target.chat.sessionId === saved.chat.sessionId) {
    // Clients can't send homeIfGone or toConversation, so the saved chat keeps the host's choice.
    return { ...target, chat: saved.chat }
  }
  const { sessionId } = target.chat
  const chat = bot ? await lookup(bot, sessionId) : null
  if (!bot || !chat) {
    throw new Error(botChatGone(bot?.name ?? 'This bot', sessionId))
  }
  return {
    ...target,
    chat: {
      sessionId,
      ...(chat.title ? { title: chat.title } : {}),
      ...(target.chat.homeIfGone ? { homeIfGone: true as const } : {}),
      ...(target.chat.toConversation ? { toConversation: true as const } : {})
    }
  }
}
