// The drawn Slack icon kept in a bot's home: one file per look, the older looks' files let go.
import { join } from 'node:path'
import { isBotAvatarImage } from '../../shared/bot-avatar'
import type { Bot } from '../../shared/bot-types'
import {
  BOT_SLACK_ICON_FOLDER,
  botSlackIconFile,
  botSlackIconLook,
  isBotSlackIconFile
} from '../../shared/bots/bot-slack-icon'
import { assertBotOwnsHome, type BotHomeFilesystem } from './bot-home'

type LookedBot = Pick<Bot, 'avatar' | 'avatarColor' | 'avatarOutfit'>

const PNG_END = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])

// A write cut short (a crash, a full disk) leaves a file without the PNG's end, read as none so it is drawn again.
function isWholeIcon(png: Uint8Array): boolean {
  return isBotAvatarImage(png) && Buffer.from(png.subarray(-PNG_END.length)).equals(PNG_END)
}

function iconFolder(home: string): string {
  return join(home, ...BOT_SLACK_ICON_FOLDER)
}

/** The kept icon for the bot's look now; null when its look needs none or none is drawn whole yet. */
export async function readBotSlackIcon(
  filesystem: BotHomeFilesystem,
  home: string,
  bot: LookedBot
): Promise<{ look: string; png: Buffer } | null> {
  const look = botSlackIconLook(bot)
  const png = look && (await filesystem.readBytes(join(iconFolder(home), botSlackIconFile(look))))
  return look && png && isWholeIcon(png) ? { look, png } : null
}

/** Whether a window should draw `look`, and whether it is the bot's look at all (a window's newer edit
 *  may not be saved yet, so it asks again once it is). */
export type BotSlackIconWant = { wanted: boolean; current: boolean }

export async function writeBotSlackIcon(
  filesystem: BotHomeFilesystem,
  home: string,
  look: string,
  png: Uint8Array
): Promise<void> {
  const folder = iconFolder(home)
  const kept = botSlackIconFile(look)
  await filesystem.makeDirectory(folder)
  await filesystem.writeBytes(join(folder, kept), png)
  for (const name of await filesystem.listNames(folder)) {
    if (name !== kept && isBotSlackIconFile(name)) {
      await filesystem.removeTree(join(folder, name))
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
      /** The bots' write queue, so a look check and its write never interleave with an edit. */
      serialize: <T>(work: () => Promise<T>) => Promise<T>
    }
  ) {}

  async wanted(botId: string, look: string): Promise<BotSlackIconWant> {
    const bot = this.deps.bot(botId)
    if (botSlackIconLook(bot) !== look) {
      return { wanted: false, current: false }
    }
    const kept = await readBotSlackIcon(this.deps.filesystem, this.deps.home(bot), bot)
    return { wanted: kept === null, current: true }
  }

  /** Keeps a window's drawing of `look`; false when the bot's look changed since, so it is dropped. */
  async store(botId: string, look: string, png: Uint8Array): Promise<boolean> {
    if (!isWholeIcon(png)) {
      throw new Error('bot_avatar_invalid')
    }
    const stored = await this.deps.serialize(async () => {
      const bot = this.deps.bot(botId)
      if (botSlackIconLook(bot) !== look) {
        return false
      }
      const home = this.deps.home(bot)
      await assertBotOwnsHome(this.deps.filesystem, home, botId)
      await writeBotSlackIcon(this.deps.filesystem, home, look, png)
      return true
    })
    if (stored) {
      for (const listener of this.listeners) {
        listener(botId)
      }
    }
    return stored
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
