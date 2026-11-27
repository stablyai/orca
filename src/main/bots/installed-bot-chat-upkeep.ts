// What a newly installed chat host does for the bots' chats once it is up.
import type { Bot } from '../../shared/bot-types'
import { backfillInstalledBotBackgroundChats } from './bot-background-chat-backfill'
import { syncInstalledTeammateHomeNames } from './bot-home-chat-name'

/** Older background chats get their rows, and each teammate's Home an older build named (or named
 *  while no chat host was open) takes the name its share has now. */
export async function upkeepInstalledBotChats(bots: () => readonly Bot[]): Promise<void> {
  await backfillInstalledBotBackgroundChats(bots)
  await syncInstalledTeammateHomeNames(bots)
}
