// A bot package applied to a bot just made the normal way: its files, the setup note its first turn reads,
// its tools and its schedules (turned off). Shared links and built-in templates both arrive this way. Any
// failure deletes the bot, so a half-made bot never stays.
import { join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import { BOT_SHARED_SETUP_FILE } from '../../shared/bots/bot-shared-from'
import type { BotPackageConnector } from '../../shared/bots/bot-package'
import type { BotController } from './bot-controller'
import { botHomeFolder, type BotHomeFilesystem } from './bot-home'
import { changeBotToolServers } from './bot-tools-file'

export type BotPackageSchedule = { name: string; prompt: string; rrule: string; timezone?: string }

/** What the bot has that its owner still sets up; its first turn offers each as the work needs it. */
export type BotPackageSetup = {
  /** Made from a link: the sharer's name, null when the account has none. */
  sharedBy?: string | null
  /** Made from a built-in template: its name, and what it does first. */
  template?: string
  firstSteps?: string
  connectors: BotPackageConnector[]
  toolsToSignIn: string[]
  schedulesOff: string[]
  eventsSuggested: { name: string; source: string; event: string; prompt?: string }[]
  /** Shown as written: a sharer's note, or what a template needs that Orca can't set up. */
  sharerNote?: string
}

export type BotPackageApply = {
  /** Files by home-relative path. */
  files: readonly { to: string; text: string }[]
  /** Ticked tools only, with no headers: the owner signs in to each themselves. */
  tools: readonly { name: string; url: string }[]
  schedules: readonly BotPackageSchedule[]
  setup: BotPackageSetup
}

export type BotPackageApplyDeps = {
  bots: Pick<BotController, 'delete'>
  filesystem: BotHomeFilesystem
  botsRoot: () => string
  /** Makes one of the bot's schedules, turned off. */
  createPausedSchedule: (bot: Bot, schedule: BotPackageSchedule) => Promise<void>
}

/** Applies `pkg` to `bot`; `finish` runs last, inside the same delete-on-failure. */
export async function applyBotPackage(
  deps: BotPackageApplyDeps,
  bot: Bot,
  pkg: BotPackageApply,
  finish: (bot: Bot) => Promise<Bot> = async (made) => made
): Promise<Bot> {
  try {
    const home = botHomeFolder(bot, deps.botsRoot())
    for (const file of pkg.files) {
      const target = join(home, ...file.to.split('/'))
      await deps.filesystem.makeDirectory(join(target, '..'))
      await deps.filesystem.writeText(target, file.text)
    }
    await deps.filesystem.makeDirectory(join(home, 'import'))
    await deps.filesystem.writeText(
      join(home, ...BOT_SHARED_SETUP_FILE.split('/')),
      `${JSON.stringify(pkg.setup, null, 2)}\n`
    )
    if (pkg.tools.length > 0) {
      await changeBotToolServers(home, () => pkg.tools.map(({ name, url }) => ({ name, url })))
    }
    for (const schedule of pkg.schedules) {
      await deps.createPausedSchedule(bot, schedule)
    }
    return await finish(bot)
  } catch (error) {
    await deps.bots.delete({ botId: bot.id, deleteFolder: true }).catch((cleanup: unknown) => {
      const why = (value: unknown) => (value instanceof Error ? value.message : String(value))
      throw new Error(
        `${why(error)} Orca couldn't remove the partly made bot "${bot.name}" (${why(cleanup)}). Delete it from Bots to try again.`,
        { cause: error }
      )
    })
    throw error
  }
}
