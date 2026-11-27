// The model and options a bot's new conversation starts on.
import type { Bot } from '../../shared/bot-types'
import { botLaunchSeedOptions } from '../../shared/bots/bot-launch'
import { explicitStructuredLaunchSeedOptions } from '../../shared/native-chat/input/session-options/native-chat-session-option-defaults'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { botHomeFolder } from './bot-home'
import { listedModelDescribing } from '../../shared/agent-session/options/model-catalog/structured-agent-session-listed-model'
import {
  findCatalogModel,
  findCatalogOption
} from '../../shared/agent-session/options/agent-session-option-catalog'
import { CODEX_SESSION_OPTION_CATALOG } from '../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-claude-codex'

type LaunchSettings = Parameters<typeof explicitStructuredLaunchSeedOptions>[0]

/**
 * The bot's own launch comes first. A conversation the owner opens keeps the chat defaults otherwise.
 * Background work (Look around, tidy-up, an automation's new conversation) never reads the model
 * remembered from the owner's last chat pick: without the bot's own model it takes the owner's
 * explicit default for the agent (Settings > Agents), else the agent's own default. A launch that
 * sets only options keeps them over that default.
 */
export function botStartOptions(
  settings: () => LaunchSettings,
  bot: Pick<Bot, 'agent' | 'folder' | 'launch'>,
  input: { background?: true; launchOptions?: Readonly<Record<string, string>> },
  host: () => Promise<StructuredAgentSessionHost>
): Record<string, string> | Promise<Record<string, string>> {
  const own = botLaunchSeedOptions(bot.launch)
  const saved =
    !input.background || own?.model
      ? (own ?? {})
      : { ...explicitStructuredLaunchSeedOptions(settings(), bot.agent), ...own }
  return input.launchOptions ? botHandoffStartOptions(bot, saved, input.launchOptions, host) : saved
}

async function botHandoffStartOptions(
  bot: Pick<Bot, 'agent' | 'folder'>,
  saved: Readonly<Record<string, string>>,
  requested: Readonly<Record<string, string>>,
  host: () => Promise<StructuredAgentSessionHost>
): Promise<Record<string, string>> {
  const model = requested.model
  if (!model || saved.model === model) {
    return { ...saved, ...requested }
  }
  const { effort, serviceTier } = saved
  if (!effort && !serviceTier) {
    return { ...requested }
  }
  const catalog = await (
    await host()
  ).deps.modelCatalog
    ?.prepareSaved({ agent: bot.agent, workspacePath: botHomeFolder(bot), verifiedOnly: true })
    .catch(() => undefined)
  const listedCatalog = catalog?.origin === 'unknown' ? undefined : catalog
  const models = listedCatalog?.models ?? []
  const canonical = (id: string) => models.find((row) => row.id === id)?.resolvedModel ?? id
  const defaultModel = listedCatalog?.listingNamesConfiguredModel
    ? models.find((row) => row.isDefault)?.id
    : undefined
  const savedModel = saved.model ?? defaultModel
  const targetId = canonical(model)
  if (savedModel && canonical(savedModel) === targetId) {
    return { ...saved, ...requested }
  }
  const listed = listedModelDescribing(models, undefined, targetId)
  const staticEffort = findCatalogOption(
    findCatalogModel(CODEX_SESSION_OPTION_CATALOG, targetId),
    'effort'
  )
  const efforts =
    listed && listed.effortsKnown !== false
      ? listed.efforts
      : staticEffort?.kind.type === 'select'
        ? staticEffort.kind.choices
        : []
  return {
    ...(effort && efforts.some(({ value }) => value === effort) ? { effort } : {}),
    ...requested
  }
}
