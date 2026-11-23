// The drawn Slack icon kept in a bot's home: one file per look, the older looks' files let go.
import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import {
  botSlackIconFile,
  botSlackIconLook,
  isBotSlackIconFile
} from '../../shared/bots/bot-slack-icon'
import { isBotAvatarImage } from '../../shared/bot-avatar'
import { assertBotOwnsHome, type BotHomeFilesystem } from './bot-home'

type LookedBot = Pick<Bot, 'avatar' | 'avatarColor' | 'avatarOutfit'>

/** The kept icon for the bot's look now; null when its look needs none or none is drawn yet. */
export async function readBotSlackIcon(
  filesystem: BotHomeFilesystem,
  home: string,
  bot: LookedBot
): Promise<{ look: string; png: Buffer } | null> {
  const look = botSlackIconLook(bot)
  const png = look && (await filesystem.readBytes(join(home, botSlackIconFile(look))))
  return look && png ? { look, png } : null
}

/** Whether `look` is the bot's look now and no icon is kept for it. */
export async function botSlackIconWanted(
  filesystem: BotHomeFilesystem,
  home: string,
  bot: LookedBot,
  look: string
): Promise<boolean> {
  return (
    botSlackIconLook(bot) === look &&
    (await filesystem.statFile(join(home, botSlackIconFile(look)))) === null
  )
}

export async function writeBotSlackIcon(
  filesystem: BotHomeFilesystem,
  home: string,
  look: string,
  png: Uint8Array
): Promise<void> {
  const kept = botSlackIconFile(look)
  await filesystem.writeBytes(join(home, kept), png)
  for (const name of await filesystem.listNames(home)) {
    if (name !== kept && isBotSlackIconFile(name)) {
      await filesystem.removeTree(join(home, name))
    }
  }
}

/** A bot's drawn icon by id: whether one is wanted, kept, and read back for the cloud. */
export class BotSlackIcons {
  private readonly listeners = new Set<(botId: string) => void>()

  constructor(
    private readonly deps: {
      filesystem: BotHomeFilesystem
      /** Throws for an unknown bot. */
      bot: (botId: string) => Bot
      home: (bot: Bot) => string
    }
  ) {}

  /** Whether a window should draw the icon for `look`: it is the bot's look now and none is kept. */
  wanted(botId: string, look: string): Promise<boolean> {
    const bot = this.deps.bot(botId)
    return botSlackIconWanted(this.deps.filesystem, this.deps.home(bot), bot, look)
  }

  /** Keeps a window's drawing of `look`; false when the bot's look changed since, so it is dropped. A
   *  look changed during the write only leaves a file the next look's write removes, never sent for it. */
  async store(botId: string, look: string, png: Uint8Array): Promise<boolean> {
    if (!isBotAvatarImage(png)) {
      throw new Error('bot_avatar_invalid')
    }
    const bot = this.deps.bot(botId)
    if (botSlackIconLook(bot) !== look) {
      return false
    }
    const home = this.deps.home(bot)
    await assertBotOwnsHome(this.deps.filesystem, home, botId)
    await writeBotSlackIcon(this.deps.filesystem, home, look, png)
    for (const listener of this.listeners) {
      listener(botId)
    }
    return true
  }

  read(botId: string): Promise<{ look: string; png: Buffer } | null> {
    const bot = this.deps.bot(botId)
    return readBotSlackIcon(this.deps.filesystem, this.deps.home(bot), bot)
  }

  onStored(listener: (botId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
