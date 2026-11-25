// What a Share dialog lists of a bot: every part it could share, ticked or not, and which source
// automation each shared one came from.
import { readFile } from 'node:fs/promises'
import { textLineCount } from '../../../shared/bots/bot-text-scan'
import type { BotShareAvailable, BotShareCandidateSummary } from '../../../shared/bots/bot-package'
import type { BotShareSelection } from './bot-package-export'
import type { BotPackageContent } from './bot-package-content'
import type { BotShareable } from './bot-share-sources'

/** The picked entries, in the bot's order; an absent list picks all. */
export const picked = <T>(
  all: readonly T[],
  names: readonly string[] | undefined,
  key: (entry: T) => string
): T[] => (names === undefined ? [...all] : all.filter((entry) => names.includes(key(entry))))

/** Every part the bot could share. A picked part reads its numbers and words from the package value,
 *  which is what goes out; an unpicked one from the home, since nothing of it does. */
export async function availableParts(
  shareable: BotShareable,
  content: BotPackageContent
): Promise<BotShareAvailable> {
  const shared = (path: string) => content.files.find((file) => file.path === path)?.text
  return {
    soulLines: textLineCount(shared('SOUL.md') ?? shareable.soul),
    skills: shareable.skills.map(({ name, description, homePath, optInFrom, optInKey }) => ({
      name,
      description: sharedDescription(shared(`skills/${name}/SKILL.md`)) ?? description,
      homePath,
      ...(optInFrom === undefined ? {} : { optInFrom, optInKey })
    })),
    schedules: shareable.schedules.map(({ automationId, name, rrule, timezone }) => ({
      automationId,
      name,
      rrule,
      ...(timezone ? { timezone } : {})
    })),
    eventSuggestions: shareable.eventSuggestions.map(({ automationId, name, source, event }) => ({
      automationId,
      name,
      source,
      event
    })),
    tools: shareable.tools.map(({ name, url }) => ({ name, url })),
    memory: await Promise.all(
      shareable.memory.map(async ({ topic, path }) => ({
        topic,
        lines: textLineCount(shared(`memory/${topic}.md`) ?? (await readFile(path, 'utf8')))
      }))
    )
  }
}

/** The description line of a shared SKILL.md, as the value rebuilt it. */
function sharedDescription(text: string | undefined): string | undefined {
  return text ? /^description: (.*)$/m.exec(text.split('\n---\n')[0] ?? '')?.[1] : undefined
}

/** The automation each shared schedule and event suggestion came from, by its index in bot.json: names
 *  repeat, ids don't. */
export function sharedAutomationIds(
  shareable: BotShareable,
  selection: BotShareSelection
): BotShareCandidateSummary['automationIds'] {
  const ids = (entries: readonly { automationId: string }[], names?: readonly string[]) =>
    picked(entries, names, (entry) => entry.automationId).map((entry) => entry.automationId)
  return {
    schedules: ids(shareable.schedules, selection.schedules),
    eventSuggestions: ids(shareable.eventSuggestions, selection.eventSuggestions)
  }
}
