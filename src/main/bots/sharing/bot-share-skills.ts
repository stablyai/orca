// The skills a Share dialog offers: the bot's own skills/, then the folder its own agent loads, then
// the other agent's. Every place a skill was found is checked on its own before precedence applies,
// so a copy reached through another folder's link never hides the real one.
import { join, relative, sep } from 'node:path'
import type { Bot } from '../../../shared/bot-types'
import {
  BOT_AGENT_SKILLS_FOLDERS,
  BOT_OWN_SKILLS_FOLDER,
  type BotAgentSkillsFolder,
  type BotShareLeftOut
} from '../../../shared/bots/bot-package'
import {
  observeSkillPackage,
  SKILL_PACKAGE_OBSERVATION_LIMITS,
  type ObservedSkillPackage
} from '../../skills/package-archive/skill-package-identity'
import { readBotOwnSkills } from '../bot-own-skills'
import { admittedSkill, type ScannedSkill } from '../bot-skill-projects'
import { ownPath, validPartName, within, type Home } from './bot-share-own-path'

export type BotShareSkill = {
  name: string
  description: string
  directory: string
  /** The skill's folder from the bot home, '/'-separated, for opening its files. */
  homePath: string
}

export async function readShareSkills(
  bot: Pick<Bot, 'agent'>,
  home: Home,
  leftOut: BotShareLeftOut[]
): Promise<BotShareSkill[]> {
  const own = await readBotOwnSkills(home.path)
  const agentFirst: BotAgentSkillsFolder[] =
    bot.agent === 'claude' ? ['claude', 'agents'] : ['agents', 'claude']
  const sources: { folder: string; skills: ScannedSkill[] }[] = [
    { folder: BOT_OWN_SKILLS_FOLDER, skills: own.skills },
    ...agentFirst.map((found) => ({
      folder: BOT_AGENT_SKILLS_FOLDERS[found],
      skills: own.agentFound.filter((skill) => skill.found === found)
    }))
  ]
  const valid: ScannedSkill[] = []
  const refused: { folder: string; entry: BotShareLeftOut }[] = []
  for (const source of sources) {
    if (source.skills.length === 0) {
      continue
    }
    const root = await ownPath(home, ...source.folder.split('/'))
    if (root === null || root === 'linked') {
      leftOut.push({ kind: 'skill', name: source.folder, why: 'linked' })
      continue
    }
    for (const skill of source.skills) {
      if (!validPartName(skill.name)) {
        refused.push({
          folder: skill.folder,
          entry: { kind: 'skill', name: skill.name, why: 'name' }
        })
      } else if (!within(root.own, skill.folder)) {
        // Reached through a link out of this folder: the owner's, unless another folder holds it.
        refused.push({
          folder: skill.folder,
          entry: { kind: 'skill', name: skill.name, why: 'outside-home' }
        })
      } else {
        valid.push(skill)
      }
    }
  }
  const homePath = (folder: string) => relative(home.real, folder).split(sep).join('/')
  const seen = new Set<string>()
  const skills: BotShareSkill[] = []
  for (const skill of valid) {
    if (seen.has(skill.folder)) {
      continue
    }
    seen.add(skill.folder)
    if (skills.some((entry) => entry.name === skill.name)) {
      leftOut.push({
        kind: 'skill',
        name: skill.name,
        why: 'duplicate',
        from: homePath(skill.folder)
      })
    } else {
      skills.push({
        name: skill.name,
        description: skill.description,
        directory: skill.folder,
        homePath: homePath(skill.folder)
      })
    }
  }
  for (const { folder, entry } of refused) {
    if (!seen.has(folder)) {
      seen.add(folder)
      leftOut.push(entry)
    }
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name, 'en-US'))
}

/** A skill's own files: a folder inside it whose SKILL.md declares a name and description (the rule
 *  discovery admits a skill by) is another skill, listed or left out on its own, so it is skipped
 *  unread and never rides along in this one's preview or archive. Any other SKILL.md is a document. */
export async function ownSkillFiles(directory: string): Promise<ObservedSkillPackage['files']> {
  const { files } = await observeSkillPackage(
    directory,
    SKILL_PACKAGE_OBSERVATION_LIMITS,
    undefined,
    undefined,
    process.platform,
    false,
    async (folder) => (await admittedSkill(join(folder, 'SKILL.md'))) !== null
  )
  return files
}
