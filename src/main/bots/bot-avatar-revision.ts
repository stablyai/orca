import { createHash } from 'node:crypto'
import {
  BOT_AVATAR_FILE,
  isBotAvatarImage,
  parseBotAvatar,
  uploadAvatar
} from '../../shared/bot-avatar'
import { join } from 'node:path'
import { z } from 'zod'
import type { Bot } from '../../shared/bot-types'
import { BotAvatarColorSchema } from '../../shared/bots/bot-avatar-color'
import { BotStoredOutfitSchema } from '../../shared/bots/bot-avatar-outfit'
import { type BotHomeFilesystem, botHomeFolder, writeBotHome } from './bot-home'

type RevisionHomes = { filesystem: BotHomeFilesystem; botsRoot: () => string }

const homePicture = z.object({
  id: z.string(),
  name: z.string(),
  agent: z.string(),
  members: z.array(z.unknown()),
  avatar: z.string().nullable(),
  avatarColor: BotAvatarColorSchema.nullable().optional(),
  avatarOutfit: BotStoredOutfitSchema.nullable().optional(),
  generatedOverMascot: z
    .string()
    .regex(/^mascot:[A-Z][0-9]+$/)
    .optional(),
  avatarRevision: z.number().int().nonnegative().optional()
})

/** Only a readable home belonging to this bot can establish a revision, including legacy zero. */
export async function botWithHomePicture(homes: RevisionHomes, bot: Bot): Promise<Bot> {
  const path = join(botHomeFolder(bot, homes.botsRoot()), 'bot.json')
  const home = await homes.filesystem
    .readText(path)
    .then((text) => homePicture.parse(JSON.parse(text ?? 'null')))
    .catch(() => {
      throw new Error('bot_avatar_home_unreadable')
    })
  if (home.id !== bot.id) {
    throw new Error('bot_folder_not_owned')
  }
  if ((home.avatarRevision ?? 0) <= (bot.avatarRevision ?? 0)) {
    return bot
  }
  return {
    ...bot,
    avatar: home.avatar,
    avatarRevision: home.avatarRevision,
    avatarColor: home.avatarColor === undefined ? bot.avatarColor : home.avatarColor,
    avatarOutfit: home.avatarOutfit === undefined ? bot.avatarOutfit : home.avatarOutfit,
    generatedOverMascot: home.generatedOverMascot
  }
}

export async function writeBotAvatarImage(
  homes: RevisionHomes,
  bot: Bot,
  png: Uint8Array,
  expectedAvatarRevision?: number
): Promise<Bot> {
  if (!isBotAvatarImage(png)) {
    throw new Error('bot_avatar_invalid')
  }
  const folderPath = botHomeFolder(bot, homes.botsRoot())
  const current = await botWithHomePicture(homes, bot)
  const revision = current.avatarRevision ?? 0
  if (expectedAvatarRevision !== undefined && expectedAvatarRevision !== revision) {
    throw new Error('bot_avatar_changed')
  }
  const version = createHash('sha256').update(png).digest('hex').slice(0, 16)
  const avatar = uploadAvatar(version)
  const next: Bot = { ...current, avatar, avatarRevision: revision + 1, updatedAt: Date.now() }
  if (
    expectedAvatarRevision !== undefined &&
    current.avatar &&
    parseBotAvatar(current.avatar)?.kind === 'mascot'
  ) {
    next.generatedOverMascot = current.avatar
  } else {
    delete next.generatedOverMascot
  }
  await homes.filesystem.writeBytes(join(folderPath, BOT_AVATAR_FILE), png)
  await writeBotHome(homes.filesystem, folderPath, next)
  return next
}
