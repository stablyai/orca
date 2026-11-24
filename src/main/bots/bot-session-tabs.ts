// A bot's sessions run for the bot, not for a tab: closing one's tab hides it and its agent keeps going.
import type { Bot } from '../../shared/bot-types'
import { botOfHomeWorkspace } from '../../shared/bots/bot-homes'
import { areHostBotsEnabled } from './bot-team-policy'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { BotController } from './bot-controller'

// Partial test hosts may omit deps; tab close already tolerates them.
type SessionLookup = {
  deps?: { store: Pick<StructuredAgentSessionHost['deps']['store'], 'getConversation'> }
}

/** The bot whose home a session lives in; null for any other session. */
export function botOfSession(
  bots: Pick<BotController, 'list'>,
  sessionId: string,
  host: SessionLookup | null = getStructuredAgentSessionHost()
): Bot | null {
  const workspaceId = host?.deps?.store.getConversation(sessionId)?.location.workspaceId
  return botOfHomeWorkspace(bots.list(), workspaceId)
}

/** Whether a session lives in a bot's home, where a closed tab leaves it running in the bot's Activity. */
export function runsForBot(
  bots: Pick<BotController, 'list'>,
  sessionId: string,
  host: SessionLookup | null = getStructuredAgentSessionHost()
): boolean {
  return botOfSession(bots, sessionId, host) !== null
}

/** The bot whose home `workspaceId` is names every chat there; with bots off a home is a plain folder. */
export function homeBotName(
  store:
    | {
        getSettings?: () => Partial<Pick<GlobalSettings, 'botsEnabled'>>
        getBots?: () => readonly Pick<Bot, 'name' | 'folderWorkspaceId'>[]
      }
    | null
    | undefined,
  workspaceId: string
): string | null {
  return areHostBotsEnabled(store?.getSettings?.())
    ? (botOfHomeWorkspace(store?.getBots?.() ?? [], workspaceId)?.name ?? null)
    : null
}
