// The drawn Slack icons, kept in an app-owned folder (never the bot's home, which its owner controls): one
// folder per bot, one file per look, the older looks' files let go.
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { crc32, inflate } from 'node:zlib'
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

// Every chunk whole with its checksum, image data that decodes, and nothing after the end: a write cut
// short (a crash, a full disk) or a PNG without usable pixels reads as none, so it is drawn again.
function hasWholeChunks(png: Uint8Array): Promise<boolean> | false {
  const bytes = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  let at = PNG_SIGNATURE_BYTES
  const data: Buffer[] = []
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
    if (type === 'IDAT') {
      data.push(bytes.subarray(at + 8, at + 8 + length))
    }
    if (type === 'IEND') {
      return end === bytes.length && pixelsInflate(bytes, data)
    }
    at = end
  }
  return false
}

// Bytes per pixel by 8-bit color type: gray, RGB, palette, gray and alpha, RGBA.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

// The image data decompresses, within the size its header gives, to exactly that size.
const inflateAsync = promisify(inflate)

// Off the main thread: zlib's pool does the inflating.
async function pixelsInflate(png: Buffer, data: Buffer[]): Promise<boolean> {
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const channels = CHANNELS[png[25] ?? -1]
  if (data.length === 0 || png[24] !== 8 || png[28] !== 0 || !channels) {
    return false
  }
  const size = height * (1 + width * channels)
  try {
    return (await inflateAsync(Buffer.concat(data), { maxOutputLength: size })).length === size
  } catch {
    return false
  }
}

async function isWholeIcon(png: Uint8Array): Promise<boolean> {
  return isBotAvatarImage(png) && (await hasWholeChunks(png))
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
  return look && png && (await isWholeIcon(png)) ? { look, png } : null
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
    if (!(await isWholeIcon(png))) {
      throw new Error('bot_avatar_invalid')
    }
    const stored = await this.deps.serialize(async () => {
      const bot = this.deps.bot(botId)
      if (botSlackIconLook(bot) !== look) {
        return 'refused'
      }
      // Another window drew it first: kept as it is, and the cloud is not sent it again.
      if (await readBotSlackIcon(this.deps.filesystem, this.deps.root(), bot)) {
        return 'kept'
      }
      await writeBotSlackIcon(this.deps.filesystem, this.deps.root(), botId, look, png)
      return 'written'
    })
    if (stored === 'written') {
      for (const listener of this.listeners) {
        listener(botId)
      }
    }
    return stored !== 'refused'
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
