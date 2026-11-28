// Whether a chat or caller lives in a bot's home folder: it is that bot's own conversation.
import type { Bot } from '../../shared/bot-types'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

/** The bot whose home holds this place, if any. */
export function botOfHome<B extends Pick<Bot, 'folderWorkspaceId'>>(
  bots: { list: () => readonly B[] } | undefined,
  place: { workspaceId: string } | undefined
): B | undefined {
  return place
    ? bots?.list().find((bot) => folderWorkspaceKey(bot.folderWorkspaceId) === place.workspaceId)
    : undefined
}

export function isInBotHome(
  bots: { list: () => readonly Pick<Bot, 'folderWorkspaceId'>[] } | undefined,
  place: { workspaceId: string } | undefined
): boolean {
  return botOfHome(bots, place) !== undefined
}
