import type { AutomationBotTarget } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { botAutomationSetup, botOnSetup } from '../../shared/bots/bot-agent-setup'

export type AutomationBotRunTarget = {
  ok: true
  cwd: string
  bot: Bot
  /** The bot's folder as a workspace key, which run history records. */
  workspaceId: string
  runsIn: AutomationBotTarget['runsIn']
}

type BotTargetStore = {
  getSettings: () => Pick<GlobalSettings, 'botsEnabled'>
  getBots?: () => Bot[]
  getFolderWorkspaces: () => FolderWorkspace[]
}

// Skip coalescing keys on exact error text.
export const BOT_MISSING = 'The bot this automation runs as no longer exists.'
export const BOT_FOLDER_MISSING = "The bot's folder is no longer available."
export const BOTS_OFF = 'Bots are turned off in Settings, so Orca skipped this run.'

export function botPausedRefusal(bot: Bot): string {
  return `${bot.name} is paused, so Orca skipped this run.`
}

export function resolveBotAutomationRunTarget(
  store: BotTargetStore,
  target: AutomationBotTarget
): AutomationBotRunTarget | { ok: false; error: string } {
  if (store.getSettings().botsEnabled === false) {
    return { ok: false, error: BOTS_OFF }
  }
  const bot = store.getBots?.().find((entry) => entry.id === target.botId)
  if (!bot) {
    return { ok: false, error: BOT_MISSING }
  }
  // Paused first: a folder deleted while paused is told once the bot is unpaused, not folded into a quiet skip.
  if (bot.paused) {
    return { ok: false, error: botPausedRefusal(bot) }
  }
  const folder = store.getFolderWorkspaces().find((entry) => entry.id === bot.folderWorkspaceId)
  if (!folder) {
    return { ok: false, error: BOT_FOLDER_MISSING }
  }
  const setup = botAutomationSetup(target, bot)
  return {
    ok: true,
    cwd: folder.folderPath,
    // The run starts on the automation's own setup when it has one; the bot's identity stays.
    bot: setup.own ? botOnSetup(bot, setup) : bot,
    workspaceId: folderWorkspaceKey(folder.id),
    runsIn: target.runsIn
  }
}
