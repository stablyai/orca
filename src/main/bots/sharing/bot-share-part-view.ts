// The exact text of one part a Share dialog page shows, flagged line by line. A picked part is read from
// the candidate's package value, the text the archive holds; an unpicked one from the bot's home, since
// nothing of it goes out.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { BotShareCandidateSummary, BotSharePartFile } from '../../../shared/bots/bot-package'
import { scanBotText } from '../../../shared/bots/bot-text-scan'
import { observeSkillPackage } from '../../skills/package-archive/skill-package-identity'
import type { BotPackageContent } from './bot-package-content'
import type { BotShareable } from './bot-share-sources'

function textFile(path: string, homePath: string | null, text: string): BotSharePartFile {
  return {
    path,
    homePath,
    text,
    flags: scanBotText(text).map(({ line, kind }) => ({ line, kind }))
  }
}

type Picked = {
  content: BotPackageContent
  summary: Pick<BotShareCandidateSummary, 'automationIds' | 'rewritten'>
}

/** The value's files under `prefix`; a file whose text was rewritten has no home line to open. */
function sharedFiles(picked: Picked, prefix: string, homePrefix: string): BotSharePartFile[] {
  return picked.content.files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => {
      const relative = file.path.slice(prefix.length)
      const homePath = picked.summary.rewritten.includes(file.path)
        ? null
        : `${homePrefix}${relative}`
      return textFile(relative || file.path, homePath, file.text)
    })
}

/** `part` is `soul`, `skill:<name>`, `memory:<topic>`, `schedule:<id>`, `event:<id>` or `tool:<name>`;
 *  automations are named by their source automation's id. */
export async function botSharePartFiles(
  shareable: BotShareable,
  part: string,
  picked: Picked
): Promise<BotSharePartFile[]> {
  const [kind, key = ''] = part.split(/:(.*)/s)
  const { bot } = picked.content
  switch (kind) {
    case 'soul':
      return sharedFiles(picked, 'SOUL.md', 'SOUL.md')
    case 'memory': {
      const note = shareable.memory.find((entry) => entry.topic === key)
      if (!note) {
        break
      }
      const homePath = `memory/${note.topic}.md`
      if (bot.memory.some((entry) => entry.topic === note.topic)) {
        return sharedFiles(picked, homePath, homePath)
      }
      return [textFile(homePath, homePath, await readFile(note.path, 'utf8'))]
    }
    case 'skill': {
      const skill = shareable.skills.find((entry) => entry.name === key)
      if (!skill) {
        break
      }
      if (bot.skills.some((entry) => entry.name === skill.name)) {
        return sharedFiles(picked, `skills/${skill.name}/`, `${skill.homePath}/`)
      }
      const observed = await observeSkillPackage(skill.directory)
      return Promise.all(
        observed.files.map(async (file) => {
          const homePath = `${skill.homePath}/${file.path}`
          return file.classification === 'text'
            ? textFile(
                file.path,
                homePath,
                await readFile(join(skill.directory, file.path), 'utf8')
              )
            : { path: file.path, homePath, text: null, flags: [] }
        })
      )
    }
    case 'schedule':
    case 'event': {
      const list = kind === 'schedule' ? shareable.schedules : shareable.eventSuggestions
      const automation = list.find((entry) => entry.automationId === key)
      if (!automation) {
        break
      }
      const ids =
        picked.summary.automationIds[kind === 'schedule' ? 'schedules' : 'eventSuggestions']
      const shared = (kind === 'schedule' ? bot.schedules : bot.eventSuggestions)[ids.indexOf(key)]
      return [textFile(automation.name, null, shared?.prompt ?? automation.prompt)]
    }
    case 'tool': {
      const tool = shareable.tools.find((entry) => entry.name === key)
      if (!tool) {
        break
      }
      const shared = bot.tools.find((entry) => entry.name === key)
      return [textFile(tool.name, null, shared?.url ?? tool.url)]
    }
  }
  throw new Error('This part is not in the bot anymore. Open Share bot again.')
}
