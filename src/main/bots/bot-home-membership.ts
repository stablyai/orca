// Whether a chat or caller lives in a bot's home folder: it is that bot's own conversation.
import type { Bot } from '../../shared/bot-types'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

export function isInBotHome(
  bots: { list: () => readonly Pick<Bot, 'folderWorkspaceId'>[] } | undefined,
  place: { workspaceId: string } | undefined
): boolean {
  return (
    place !== undefined &&
    (bots?.list().some((bot) => folderWorkspaceKey(bot.folderWorkspaceId) === place.workspaceId) ??
      false)
  )
}
