// Bot news for its owner, through the runtime's owner notice (a banner and a phone push): a run that
// couldn't finish, and a person asking for access.
import type { Automation } from '../../shared/automations/automation-definition'
import type { Bot } from '../../shared/bot-types'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/agent-session/view/structured-agent-session-projection'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { OwnerNotice } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { BOT_FOLDER_MISSING } from '../automations/bot-run-target'
import { botOwnerNoticeText } from './bot-owner-notice-copy'

export type BotOwnerNotice = Pick<OwnerNotice, 'title' | 'body' | 'phone'>

export type BotOwnerNoticeDeps = {
  /** The runtime's owner notice: a banner and a phone push, under the notifications switch. */
  notify(notice: OwnerNotice): void
}

export const BOT_COULD_NOT_FINISH_COPY = {
  title: (bot: string) => botOwnerNoticeText('couldNotFinish', { bot }),
  turnEnded: (automation: string) => botOwnerNoticeText('turnEnded', { automation }),
  folderMissing: (automation: string) => botOwnerNoticeText('folderMissing', { automation }),
  sessionRefused: (automation: string) => botOwnerNoticeText('sessionRefused', { automation })
}

/** The runtime's owner notice, for every bot alert. */
export function runtimeBotOwnerNotice(runtime: OrcaRuntimeService): BotOwnerNoticeDeps {
  return {
    notify: (notice) => {
      if (notice.worktreeId && runtime.isWorkspaceNotificationMuted(notice.worktreeId)) {
        return
      }
      runtime.dispatchOwnerNotice(notice, runtime.requireStore().getSettings().notifications)
    }
  }
}

/** For a run that couldn't finish. A turn that ended passes phone: false, since its failed turn already pushed. */
export function notifyBotCouldNotFinish(
  deps: BotOwnerNoticeDeps,
  bot: Bot,
  automation: Pick<Automation, 'name'>,
  notice: BotOwnerNotice,
  sessionId?: string
): void {
  if (bot.paused || !bot.notifications.couldNotFinish) {
    return
  }
  // The Home Chat opens on tap; with none yet, the bot's home does.
  const tapSession = sessionId ?? bot.chatSessionId
  deps.notify({
    id: `bot-could-not-finish:${bot.id}:${automation.name}`,
    ...notice,
    worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
    ...(tapSession
      ? {
          paneKey: structuredAgentSessionPaneKey(
            structuredAgentSessionTabId(tapSession),
            tapSession
          )
        }
      : {})
  })
}

/**
 * A refused bot run's owner hears of it only when the bot can't run as set up: its folder is gone.
 * Paused, off, or removed bots skip quietly.
 */
export function botRunRefusalAlerts(
  deps: BotOwnerNoticeDeps,
  bots: () => readonly Bot[]
): (automation: Pick<Automation, 'name' | 'bot'>, error: string) => void {
  return (automation, error) => {
    const botId = automation.bot?.botId
    const bot = botId === undefined ? undefined : bots().find((entry) => entry.id === botId)
    if (bot && error === BOT_FOLDER_MISSING) {
      notifyBotCouldNotFinish(deps, bot, automation, {
        title: BOT_COULD_NOT_FINISH_COPY.title(bot.name),
        body: BOT_COULD_NOT_FINISH_COPY.folderMissing(automation.name)
      })
    }
  }
}

/** Its session refused the prompt or couldn't open, so no turn began. */
export function alertBotCouldNotStart(
  deps: BotOwnerNoticeDeps,
  bot: Bot,
  automation: Pick<Automation, 'name'>
): void {
  notifyBotCouldNotFinish(deps, bot, automation, {
    title: BOT_COULD_NOT_FINISH_COPY.title(bot.name),
    body: BOT_COULD_NOT_FINISH_COPY.sessionRefused(automation.name)
  })
}
