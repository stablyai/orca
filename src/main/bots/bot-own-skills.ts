// A bot's own skills: one folder in its home, skills/<name>/SKILL.md, with a link to each in every
// agent's skills folder so whichever agent the bot runs on loads them. Orca only ever creates a
// missing link there: it never removes, replaces or rewrites anything in an agent's folder, so a
// skill taken out of skills/ leaves its links dangling. Skills an agent's folder holds itself (older
// bots) stay where they are and load for that agent only.
import { lstat, mkdir, readdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BOT_AGENT_SKILLS_FOLDERS,
  BOT_OWN_SKILLS_FOLDER,
  type BotAgentSkillsFolder
} from '../../shared/bots/bot-package'
import type { BotOwnSkillsView } from '../../shared/bots/bot-skill-projects'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import { admittedSkill, type ScannedSkill, scanSkillsFolder } from './bot-skill-projects'

export type BotOwnSkills = {
  skillsDir: string
  /** By folder name under skills/. */
  skills: (ScannedSkill & { entry: string })[]
  /** What each agent's folder holds besides links into skills/, one entry per folder it was found
   *  in: a skill both folders reach is listed under each. */
  agentFound: (ScannedSkill & { found: BotAgentSkillsFolder })[]
}

const AGENT_FOLDERS: readonly (readonly [BotAgentSkillsFolder, string])[] = [
  ['claude', BOT_AGENT_SKILLS_FOLDERS.claude],
  ['agents', BOT_AGENT_SKILLS_FOLDERS.agents]
]

/** `segments` under the home: a real folder there (no link on the way), missing with nothing on the
 *  way a link, or anything else. */
async function realFolder(
  home: string,
  realHome: string,
  segments: readonly string[]
): Promise<'real' | 'missing' | 'other'> {
  for (let depth = 1; depth <= segments.length; depth += 1) {
    const path = join(home, ...segments.slice(0, depth))
    const entry = await lstat(path).catch(() => null)
    if (!entry) {
      return 'missing'
    }
    const expected = join(realHome, ...segments.slice(0, depth))
    if (!entry.isDirectory() || (await realpath(path)) !== expected) {
      return 'other'
    }
  }
  return 'real'
}

/** skills/'s own skills: real folders right under it (never links) holding a SKILL.md. */
async function ownSkillEntries(home: string, realHome: string): Promise<BotOwnSkills['skills']> {
  if ((await realFolder(home, realHome, [BOT_OWN_SKILLS_FOLDER])) !== 'real') {
    return []
  }
  const skillsDir = join(realHome, BOT_OWN_SKILLS_FOLDER)
  const entries = await readdir(skillsDir, { withFileTypes: true })
  const skills = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(async (entry) => {
        const skill = await admittedSkill(join(skillsDir, entry.name, 'SKILL.md'))
        return skill ? [{ ...skill, entry: entry.name }] : []
      })
  )
  return skills.flat().sort((a, b) => a.name.localeCompare(b.name))
}

/** The bot's skills as Settings and Share both read them: skills/, then what each agent's folder holds. */
export async function readBotOwnSkills(home: string): Promise<BotOwnSkills> {
  const realHome = await realpath(home)
  const skills = await ownSkillEntries(home, realHome)
  const ownRoot = join(realHome, BOT_OWN_SKILLS_FOLDER)
  const agentFound: BotOwnSkills['agentFound'] = []
  for (const [found, folder] of AGENT_FOLDERS) {
    for (const skill of await scanSkillsFolder(join(home, folder))) {
      if (!isPathInsideOrEqual(ownRoot, skill.folder)) {
        agentFound.push({ ...skill, found })
      }
    }
  }
  return { skillsDir: join(home, BOT_OWN_SKILLS_FOLDER), skills, agentFound }
}

/** Settings' view: one row per real skill folder, with every agent folder that loads it. */
export async function botOwnSkillsView(home: string): Promise<BotOwnSkillsView> {
  const own = await readBotOwnSkills(home)
  const byFolder = new Map<string, BotOwnSkillsView['agentOnly'][number]>()
  for (const skill of own.agentFound) {
    const row = byFolder.get(skill.folder)
    if (row) {
      row.loadedBy.push(skill.found)
    } else {
      byFolder.set(skill.folder, {
        name: skill.name,
        description: skill.description,
        folder: skill.folder,
        loadedBy: [skill.found]
      })
    }
  }
  const first = own.agentFound[0]
  const opens =
    own.skills.length === 0 && first && !(await lstat(own.skillsDir).catch(() => null))
      ? join(home, BOT_AGENT_SKILLS_FOLDERS[first.found])
      : own.skillsDir
  return {
    skillsDir: opens,
    skills: own.skills.map(({ name, description, folder }) => ({ name, description, folder })),
    agentOnly: [...byFolder.values()]
  }
}

/** Creates each missing link from the agents' folders to skills/. Whatever is already at a name
 *  (a file, a folder, any link, even a dangling one) is left as it is, and nothing is ever removed. */
export async function linkBotOwnSkills(home: string): Promise<void> {
  const realHome = await realpath(home)
  const skills = await ownSkillEntries(home, realHome)
  if (skills.length === 0) {
    return
  }
  for (const [, folder] of AGENT_FOLDERS) {
    const segments = folder.split('/')
    const state = await realFolder(home, realHome, segments)
    if (state === 'other') {
      continue
    }
    if (state === 'missing') {
      await mkdir(join(realHome, ...segments), { recursive: true })
    }
    for (const skill of skills) {
      await symlink(
        join(realHome, BOT_OWN_SKILLS_FOLDER, skill.entry),
        join(realHome, ...segments, skill.entry),
        process.platform === 'win32' ? 'junction' : 'dir'
      ).catch((error: NodeJS.ErrnoException) => {
        // Taken, or not creatable: left alone either way.
        if (error.code !== 'EEXIST') {
          console.warn('[bots] a skill link could not be made', folder, skill.entry, error.code)
        }
      })
    }
  }
}
