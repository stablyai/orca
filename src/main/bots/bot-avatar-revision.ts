import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import {
  BOT_AVATAR_FILE,
  isBotAvatarImage,
  parseBotAvatar,
  uploadAvatar
} from '../../shared/bot-avatar'
import type { Bot } from '../../shared/bot-types'
import { BotAvatarColorSchema } from '../../shared/bots/bot-avatar-color'
import { BotStoredOutfitSchema } from '../../shared/bots/bot-avatar-outfit'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { type BotHomeFilesystem, botHomeFolder, writeBotHome } from './bot-home'

type RevisionHomes = { filesystem: BotHomeFilesystem; botsRoot: () => string }
type Workspaces = () => readonly FolderWorkspace[]
type HomePicture = { bot: Bot; known: boolean; ownership: 'manifest' | 'workspace' | 'unreadable' }

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
  avatarRevision: z.number().int().nonnegative().optional(),
  avatarRevisionEpoch: z.uuid().optional()
})

export async function readBotHomePicture(homes: RevisionHomes, bot: Bot): Promise<HomePicture> {
  const path = join(botHomeFolder(bot, homes.botsRoot()), 'bot.json')
  const text = await homes.filesystem.readText(path).catch(() => null)
  let record: unknown
  try {
    record = JSON.parse(text ?? 'null')
  } catch {
    record = null
  }
  const owner = record && typeof record === 'object' && 'id' in record ? record.id : undefined
  if (typeof owner === 'string' && owner !== bot.id) {
    throw new Error('bot_folder_not_owned')
  }
  const parsed = homePicture.safeParse(record)
  if (!parsed.success) {
    // An existing file that could not be read might identify a different owner.
    if (text === null && (await homes.filesystem.statFile(path))) {
      return { bot, known: false, ownership: 'unreadable' }
    }
    return { bot, known: false, ownership: owner === bot.id ? 'manifest' : 'workspace' }
  }
  const home = parsed.data
  const samePicture =
    home.avatar === bot.avatar &&
    (home.avatarColor === undefined || home.avatarColor === (bot.avatarColor ?? null)) &&
    (home.avatarOutfit === undefined || home.avatarOutfit === (bot.avatarOutfit ?? null))
  const revision = home.avatarRevision ?? 0
  const profileRevision = bot.avatarRevision ?? 0
  if (
    (home.avatarRevisionEpoch !== undefined && home.avatarRevision === undefined) ||
    (!home.avatarRevisionEpoch && bot.avatarRevisionEpoch) ||
    (home.avatarRevisionEpoch === bot.avatarRevisionEpoch &&
      !samePicture &&
      (home.avatarRevision === undefined || revision === profileRevision))
  ) {
    return { bot, known: false, ownership: 'manifest' }
  }
  if (home.avatarRevisionEpoch === bot.avatarRevisionEpoch && revision <= profileRevision) {
    return { bot, known: true, ownership: 'manifest' }
  }
  return {
    known: true,
    ownership: 'manifest',
    bot: {
      ...bot,
      avatar: home.avatar,
      avatarRevision: revision,
      avatarRevisionEpoch: home.avatarRevisionEpoch,
      avatarColor: home.avatarColor === undefined ? bot.avatarColor : home.avatarColor,
      avatarOutfit: home.avatarOutfit === undefined ? bot.avatarOutfit : home.avatarOutfit,
      generatedOverMascot: home.generatedOverMascot
    }
  }
}

export function knownBotPicture(home: HomePicture): Bot {
  if (!home.known) {
    throw new Error('bot_avatar_home_unreadable')
  }
  return home.bot
}

/** Explicit choices may restart a damaged revision history in the bot's registered home. */
export function botForManualPicture(
  homes: RevisionHomes,
  home: HomePicture,
  workspaces: Workspaces
): Bot {
  if (home.known) {
    return home.bot
  }
  const bot = home.bot
  if (home.ownership === 'unreadable') {
    throw new Error('bot_avatar_home_unreadable')
  }
  if (home.ownership === 'workspace') {
    const folder = botHomeFolder(bot, homes.botsRoot())
    const workspace = workspaces().find((w) => w.id === bot.folderWorkspaceId)
    if (
      !workspace ||
      workspace.connectionId ||
      normalizeRuntimePathForComparison(workspace.folderPath) !==
        normalizeRuntimePathForComparison(folder)
    ) {
      throw new Error('bot_folder_not_owned')
    }
  }
  return { ...bot, avatarRevisionEpoch: randomUUID(), generatedOverMascot: undefined }
}

export async function writeBotAvatarImage(
  homes: RevisionHomes,
  bot: Bot,
  png: Uint8Array,
  workspaces: Workspaces,
  expectedAvatarRevision?: number,
  expectedAvatarEpoch?: string
): Promise<Bot> {
  if (!isBotAvatarImage(png)) {
    throw new Error('bot_avatar_invalid')
  }
  const folder = botHomeFolder(bot, homes.botsRoot())
  const home = await readBotHomePicture(homes, bot)
  const current =
    expectedAvatarRevision === undefined
      ? botForManualPicture(homes, home, workspaces)
      : knownBotPicture(home)
  const revision = current.avatarRevision ?? 0
  if (
    expectedAvatarRevision !== undefined &&
    (expectedAvatarRevision !== revision || expectedAvatarEpoch !== current.avatarRevisionEpoch)
  ) {
    throw new Error('bot_avatar_changed')
  }
  const version = createHash('sha256').update(png).digest('hex').slice(0, 16)
  const next: Bot = {
    ...current,
    avatar: uploadAvatar(version),
    avatarRevision: revision + 1,
    updatedAt: Date.now()
  }
  if (
    expectedAvatarRevision !== undefined &&
    current.avatar &&
    parseBotAvatar(current.avatar)?.kind === 'mascot'
  ) {
    next.generatedOverMascot = current.avatar
  } else {
    delete next.generatedOverMascot
  }
  await homes.filesystem.writeBytes(join(folder, BOT_AVATAR_FILE), png)
  await writeBotHome(homes.filesystem, folder, next)
  return next
}
