// The drawn Slack icons, kept in an app-owned folder (never the bot's home, which its owner controls): one
// folder per bot, one file per look, the older looks' files let go.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { isBotAvatarImage } from '../../shared/bot-avatar'
import type { Bot } from '../../shared/bot-types'
import {
  botSlackIconFile,
  botSlackIconLook,
  isBotSlackIconFile
} from '../../shared/bots/bot-slack-icon'
import type { BotHomeFilesystem } from './bot-home'

type LookedBot = Pick<Bot, 'id' | 'avatar' | 'avatarColor' | 'avatarOutfit'>

const PNG_SIGNATURE_BYTES = 8

// Every chunk whole with its checksum, image data present, and nothing after the end: a write cut short
// (a crash, a full disk) or a PNG without pixels reads as none, so it is drawn again.
function hasWholeChunks(png: Uint8Array): boolean {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  let at = PNG_SIGNATURE_BYTES
  let data = false
  while (at + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(at)
    const end = at + 12 + length
    if (end > bytes.length) {
      return false
    }
    const type = bytes.toString('latin1', at + 4, at + 8)
    if (crc32(bytes.subarray(at + 4, at + 8 + length)) !== bytes.readUInt32BE(at + 8 + length)) {
      return false
    }
    data ||= type === 'IDAT' && length > 0
    if (type === 'IEND') {
      return data && end === bytes.length
    }
    at = end
  }
  return false
}

function isWholeIcon(png: Uint8Array): boolean {
  return isBotAvatarImage(png) && hasWholeChunks(png)
}

// Named by a hash of the id, so no id can name a path outside the root.
function botFolder(root: string, botId: string): string {
  return join(root, createHash('sha256').update(botId).digest('hex').slice(0, 32))
}

/** The kept icon for the bot's look now; null when its look needs none or none is drawn whole yet. */
export async function readBotSlackIcon(
  filesystem: BotHomeFilesystem,
  root: string,
  bot: LookedBot
): Promise<{ look: string; png: Buffer } | null> {
  const look = botSlackIconLook(bot)
  const png =
    look && (await filesystem.readBytes(join(botFolder(root, bot.id), botSlackIconFile(look))))
  return look && png && isWholeIcon(png) ? { look, png } : null
}

/** Whether a window should draw `look`, and whether it is the bot's look at all (a window's newer edit
 *  may not be saved yet, so it asks again once it is). */
export type BotSlackIconWant = { wanted: boolean; current: boolean }

export async function writeBotSlackIcon(
  filesystem: BotHomeFilesystem,
  root: string,
  botId: string,
  look: string,
  png: Uint8Array
): Promise<void> {
  const folder = botFolder(root, botId)
  const kept = botSlackIconFile(look)
  await filesystem.makeDirectory(folder)
  await filesystem.writeBytes(join(folder, kept), png)
  // Best effort: a leftover older look is never read, since the look names the file.
  try {
    for (const name of await filesystem.listNames(folder)) {
      if (name !== kept && isBotSlackIconFile(name)) {
        await filesystem.removeTree(join(folder, name))
      }
    }
  } catch (error) {
    console.warn('[bots] could not remove an older Slack icon', error)
  }
}

/** A bot's drawn icon by id: whether one is wanted, kept, and read back for the cloud. */
export class BotSlackIcons {
  private readonly listeners = new Set<(botId: string) => void>()

  constructor(
    private readonly deps: {
      filesystem: BotHomeFilesystem
      root: () => string
      /** Throws for an unknown bot. */
      bot: (botId: string) => Bot
      /** The bots' write queue, so a look check and its write never interleave with an edit. */
      serialize: <T>(work: () => Promise<T>) => Promise<T>
    }
  ) {}

  async wanted(botId: string, look: string): Promise<BotSlackIconWant> {
    const bot = this.deps.bot(botId)
    if (botSlackIconLook(bot) !== look) {
      return { wanted: false, current: false }
    }
    const kept = await readBotSlackIcon(this.deps.filesystem, this.deps.root(), bot)
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
      await writeBotSlackIcon(this.deps.filesystem, this.deps.root(), botId, look, png)
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
    return readBotSlackIcon(this.deps.filesystem, this.deps.root(), this.deps.bot(botId))
  }

  /** A deleted bot's icons go with it. */
  forget(botId: string): Promise<void> {
    return this.deps.filesystem.removeTree(botFolder(this.deps.root(), botId))
  }

  onStored(listener: (botId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
