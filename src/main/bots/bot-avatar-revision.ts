// A bot's avatar revision, which every picture, color or outfit write bumps (see bots.avatar.upload's
// `expectedAvatarRevision`). The record saves on a debounce but the home's bot.json at once, so after a
// crash bot.json can be ahead; the higher of the two is the revision.
import type { Bot } from '../../shared/bot-types'
import { type BotHomeFilesystem, botHomeAvatarRevision, botHomeFolder } from './bot-home'

type RevisionHomes = { filesystem: BotHomeFilesystem; botsRoot: () => string }

/** The higher of the record's revision and its home's bot.json. */
export async function botAvatarRevision(homes: RevisionHomes, bot: Bot): Promise<number> {
  const home = await botHomeAvatarRevision(homes.filesystem, botHomeFolder(bot, homes.botsRoot()))
  return Math.max(bot.avatarRevision ?? 0, home)
}

type RevisionStore = { getBots?: () => Bot[]; saveBot?: (bot: Bot) => void }

const repairs = new WeakMap<object, Promise<void>>()

/**
 * Once per store, before its bots are first listed: a record left behind its home's bot.json (the
 * profile lost its last save) is raised to it. A fresh read then anchors a new Generate at the real
 * revision, while a request made before the crash still holds the older one and is refused.
 */
export function repairBotAvatarRevisions(
  store: RevisionStore | null | undefined,
  homes: RevisionHomes
): Promise<void> {
  if (!store?.getBots || !store.saveBot) {
    return Promise.resolve()
  }
  let repair = repairs.get(store)
  if (!repair) {
    repair = raiseBehindRecords(store, homes).catch((error: unknown) => {
      console.warn('[bots] could not read the avatar revisions of bot homes', error)
    })
    repairs.set(store, repair)
  }
  return repair
}

async function raiseBehindRecords(store: RevisionStore, homes: RevisionHomes): Promise<void> {
  for (const { id } of store.getBots?.() ?? []) {
    const listed = store.getBots?.().find((entry) => entry.id === id)
    const home = listed ? await botAvatarRevision(homes, listed) : 0
    // Read again after the await: a write since may have saved the record, and it wins.
    const current = store.getBots?.().find((entry) => entry.id === id)
    if (current && home > (current.avatarRevision ?? 0)) {
      store.saveBot?.({ ...current, avatarRevision: home })
    }
  }
}
