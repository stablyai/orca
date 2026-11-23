import type { AutomationBotTarget } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import { botAutomationSetup, botOnSetup } from '../../shared/bots/bot-agent-setup'
import { botsBlockedByTeam } from '../bots/bot-team-policy'
import {
  AUTOMATION_RUN_FAILURE_COPY,
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automations/history/automation-run-failure-copy'

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
export const BOT_FOLDER_MISSING = AUTOMATION_RUN_FAILURE_COPY.botFolderMissing

export function resolveBotAutomationRunTarget(
  store: BotTargetStore,
  target: AutomationBotTarget
): AutomationBotRunTarget | ({ ok: false } & AutomationRunFailure) {
  if (botsBlockedByTeam()) {
    return { ok: false, ...automationRunFailure('botsOffByTeam') }
  }
  if (store.getSettings().botsEnabled === false) {
    return { ok: false, ...automationRunFailure('botsOff') }
  }
  const bot = store.getBots?.().find((entry) => entry.id === target.botId)
  if (!bot) {
    return { ok: false, ...automationRunFailure('botMissing') }
  }
  // Paused first: a folder deleted while paused is told once the bot is unpaused, not folded into a quiet skip.
  if (bot.paused) {
    return { ok: false, ...automationRunFailure('botPaused', { bot: bot.name }) }
  }
  const folder = store.getFolderWorkspaces().find((entry) => entry.id === bot.folderWorkspaceId)
  if (!folder) {
    return { ok: false, ...automationRunFailure('botFolderMissing') }
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
