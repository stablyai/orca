// A bot's own skills: one folder in its home, skills/<name>/SKILL.md, with a link to each in every
// agent's skills folder so whichever agent the bot runs on loads them. Skills an agent's folder holds
// itself (older bots) stay where they are and load for that agent only.
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  BOT_AGENT_SKILLS_FOLDERS,
  BOT_OWN_SKILLS_FOLDER,
  type BotAgentSkillsFolder
} from '../../shared/bots/bot-package'
import type { BotOwnSkillsView } from '../../shared/bots/bot-skill-projects'
import { isPathInsideOrEqual } from '../../shared/file-access/cross-platform-path'
import {
  admittedSkill,
  type ScannedSkill,
  scanSkillsFolder,
  serialized
} from './bot-skill-projects'

export type BotOwnSkills = {
  skillsDir: string
  /** By folder name under skills/. */
  skills: (ScannedSkill & { entry: string })[]
  /** Skills only one agent's folder holds, not links to skills/. */
  agentOnly: (ScannedSkill & { only: BotAgentSkillsFolder })[]
}

const AGENT_FOLDERS: readonly (readonly [BotAgentSkillsFolder, string])[] = [
  ['claude', BOT_AGENT_SKILLS_FOLDERS.claude],
  ['agents', BOT_AGENT_SKILLS_FOLDERS.agents]
]

/** The links Orca made, by home-relative path, with the target each was made with. Only these are
 *  ever removed, and only while they still point where Orca pointed them. */
const LINKS_RECORD = ['.orca', 'skill-links.json'] as const
type LinksRecord = Record<string, string>

/** `segments` under the home, when every part of it is a real folder in the home (no link on the
 *  way); `missing` when it doesn't exist yet but nothing on the way is a link. */
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
    if (
      !entry.isDirectory() ||
      (await realpath(path)) !== join(realHome, ...segments.slice(0, depth))
    ) {
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

/** The bot's skills as Settings and Share both read them: skills/, then what only one agent's folder holds. */
export async function readBotOwnSkills(home: string): Promise<BotOwnSkills> {
  const realHome = await realpath(home)
  const skills = await ownSkillEntries(home, realHome)
  const ownRoot = join(realHome, BOT_OWN_SKILLS_FOLDER)
  const seen = new Set(skills.map((skill) => skill.folder))
  const agentOnly: BotOwnSkills['agentOnly'] = []
  for (const [only, folder] of AGENT_FOLDERS) {
    for (const skill of await scanSkillsFolder(join(home, folder))) {
      if (!seen.has(skill.folder) && !isPathInsideOrEqual(ownRoot, skill.folder)) {
        seen.add(skill.folder)
        agentOnly.push({ ...skill, only })
      }
    }
  }
  return { skillsDir: join(home, BOT_OWN_SKILLS_FOLDER), skills, agentOnly }
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

async function readRecord(home: string): Promise<LinksRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(home, ...LINKS_RECORD), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

async function writeRecord(home: string, record: LinksRecord): Promise<void> {
  const path = join(home, ...LINKS_RECORD)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(`${path}.tmp`, `${JSON.stringify(record, null, 2)}\n`)
  await rename(`${path}.tmp`, path)
}

/** Where a link points, as written; a Windows junction reads back with its \\?\ prefix and a
 *  trailing separator. */
async function linkTarget(path: string): Promise<string | null> {
  const entry = await lstat(path).catch(() => null)
  if (!entry?.isSymbolicLink()) {
    return null
  }
  const target = await readlink(path).catch(() => null)
  return target?.replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '') ?? null
}

/** Brings each agent's folder in the home up to date with skills/: one link per skill. Orca removes
 *  only links it recorded making that still point where it made them, and never takes over a name
 *  something else holds. A link made but not yet recorded (a crash between the two) is left alone. */
export function syncBotOwnSkills(home: string): Promise<void> {
  return serialized(join(home, BOT_OWN_SKILLS_FOLDER), async () => {
    const realHome = await realpath(home)
    const skills = await ownSkillEntries(home, realHome)
    const record = await readRecord(home)
    const next: LinksRecord = {}
    for (const [, folder] of AGENT_FOLDERS) {
      const segments = folder.split('/')
      const state = await realFolder(home, realHome, segments)
      const wanted = new Map(
        skills.map((skill) => [
          `${folder}/${skill.entry}`,
          join(realHome, BOT_OWN_SKILLS_FOLDER, skill.entry)
        ])
      )
      for (const [path, target] of Object.entries(record)) {
        if (!path.startsWith(`${folder}/`)) {
          continue
        }
        if (state !== 'real') {
          // Never reach through a folder that became a link; keep the record for later.
          next[path] = target
          continue
        }
        const linkPath = join(home, ...path.split('/'))
        if ((await linkTarget(linkPath)) !== target) {
          continue
        }
        if (wanted.get(path) === target) {
          next[path] = target
        } else {
          await rm(linkPath, { force: true })
        }
      }
      if (state === 'other') {
        continue
      }
      for (const [path, target] of wanted) {
        if (next[path] !== undefined) {
          continue
        }
        await mkdir(join(home, ...segments), { recursive: true })
        const made = await symlink(
          target,
          join(home, ...path.split('/')),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
          .then(() => true)
          .catch((error: NodeJS.ErrnoException) => {
            // Taken by something Orca didn't make: left alone, never adopted.
            if (error.code === 'EEXIST') {
              return false
            }
            throw error
          })
        if (made) {
          next[path] = target
          // Recorded at once, so a crash later in the sync never strands a link Orca made.
          await writeRecord(home, { ...record, ...next })
        }
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(record)) {
      await writeRecord(home, next)
    }
  })
}
