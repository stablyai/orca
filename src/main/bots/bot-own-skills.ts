// A bot's own skills: one folder in its home, skills/<name>/SKILL.md, with a link to each in every
// agent's skills folder so whichever agent the bot runs on loads them. Skills an agent's folder holds
// itself (older bots) stay where they are and load for that agent only.
import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  BOT_AGENT_SKILLS_FOLDERS,
  BOT_OWN_SKILLS_FOLDER,
  type BotAgentSkillsFolder
} from '../../shared/bots/bot-package'
import type { BotOwnSkillsView } from '../../shared/bots/bot-skill-projects'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import {
  type LinkScope,
  type ScannedSkill,
  scanSkillsFolder,
  serialized,
  skillLinks,
  syncLinks
} from './bot-skill-projects'

export type BotOwnSkills = {
  skillsDir: string
  skills: ScannedSkill[]
  /** Skills only one agent's folder holds, not links to skills/. */
  agentOnly: (ScannedSkill & { only: BotAgentSkillsFolder })[]
}

const AGENT_FOLDERS: readonly (readonly [BotAgentSkillsFolder, string])[] = [
  ['claude', BOT_AGENT_SKILLS_FOLDERS.claude],
  ['agents', BOT_AGENT_SKILLS_FOLDERS.agents]
]

/** skills/ as written and as resolved, so a link to it counts either way. */
async function ownFolders(home: string): Promise<string[]> {
  const skillsDir = join(home, BOT_OWN_SKILLS_FOLDER)
  const real = await realpath(skillsDir).catch(() => null)
  return real && real !== skillsDir ? [skillsDir, real] : [skillsDir]
}

const insideAny = (roots: readonly string[], path: string): boolean =>
  roots.some((root) => isPathInsideOrEqual(root, path))

/** The bot's skills as Settings and Share both read them: skills/, then what only one agent's folder holds. */
export async function readBotOwnSkills(home: string): Promise<BotOwnSkills> {
  const roots = await ownFolders(home)
  const skills = await scanSkillsFolder(roots[0])
  const seen = new Set(skills.map((skill) => skill.folder))
  const agentOnly: BotOwnSkills['agentOnly'] = []
  for (const [only, folder] of AGENT_FOLDERS) {
    for (const skill of await scanSkillsFolder(join(home, folder))) {
      if (!seen.has(skill.folder) && !insideAny(roots, skill.folder)) {
        seen.add(skill.folder)
        agentOnly.push({ ...skill, only })
      }
    }
  }
  return { skillsDir: roots[0], skills, agentOnly }
}

export async function botOwnSkillsView(home: string): Promise<BotOwnSkillsView> {
  const own = await readBotOwnSkills(home)
  const first = own.agentOnly[0]
  const opens =
    own.skills.length === 0 && first && !(await lstat(own.skillsDir).catch(() => null))
      ? join(home, BOT_AGENT_SKILLS_FOLDERS[first.only])
      : own.skillsDir
  return {
    skillsDir: opens,
    skills: own.skills.map(({ name, description }) => ({ name, description })),
    agentOnly: own.agentOnly.map(({ name, description, only }) => ({ name, description, only }))
  }
}

/** An agent folder Orca may link into: missing, or a real folder in the home (never through a link). */
async function linkableFolder(home: string, folder: string): Promise<boolean> {
  const realHome = await realpath(home)
  let path = join(home, folder)
  while (path !== home) {
    const entry = await lstat(path).catch(() => null)
    if (entry) {
      return (
        entry.isDirectory() && (await realpath(path)) === join(realHome, path.slice(home.length))
      )
    }
    path = dirname(path)
  }
  return true
}

/** Brings each agent's folder in the home up to date with skills/: one link per skill. Only Orca's
 *  links (those pointing into skills/) are made or removed; a name something else holds is left alone. */
export function syncBotOwnSkills(home: string): Promise<void> {
  return serialized(join(home, BOT_OWN_SKILLS_FOLDER), async () => {
    const roots = await ownFolders(home)
    const links = skillLinks(await scanSkillsFolder(roots[0]))
    const scope: LinkScope = {
      owns: async (link) => {
        // A Windows junction reads back with its \\?\ prefix.
        const target = (await readlink(link).catch(() => null))?.replace(/^\\\\\?\\/, '')
        return target !== undefined && insideAny(roots, resolve(dirname(link), target))
      },
      leaveTaken: true
    }
    for (const [, folder] of AGENT_FOLDERS) {
      const dir = join(home, folder)
      const present = (await lstat(dir).catch(() => null)) !== null
      if ((links.size > 0 || present) && (await linkableFolder(home, folder))) {
        await syncLinks(dir, links, scope)
      }
    }
  })
}
