// The skills a Share dialog offers: the bot's own skills/, then the folder its own agent loads, then
// the other agent's, then its linked projects' (as Settings lists them). Every place a skill was found
// is checked on its own before precedence applies, so a copy reached through another folder's link
// never hides the real one.
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Bot } from '../../../shared/bot-types'
import {
  BOT_PACKAGE_SKILLS_MAX,
  BOT_AGENT_SKILLS_FOLDERS,
  BOT_OWN_SKILLS_FOLDER,
  type BotAgentSkillsFolder,
  type BotShareLeftOut
} from '../../../shared/bots/bot-package'
import {
  checkSkillPackageShape,
  observeSkillPackage,
  SKILL_PACKAGE_OBSERVATION_LIMITS,
  type ObservedSkillPackage
} from '../../skills/package-archive/skill-package-identity'
import { readBotOwnSkills } from '../bot-own-skills'
import { admittedSkill, scanSkillProject, type ScannedSkill } from '../bot-skill-projects'
import { ownPath, validPartName, within, type Home } from './bot-share-own-path'

export type BotShareSkill = {
  name: string
  description: string
  directory: string
  /** The skill's folder from the bot home, '/'-separated, for opening its files; null for a linked
   *  project's skill, which lives outside the home. */
  homePath: string | null
  /** The linked project's name, for a skill it links in from outside itself: listed, not ticked. */
  optInFrom?: string
  /** That skill's folder as a key the owner's tick names, so a tick holds only for this folder. */
  optInKey?: string
}

/** A project the bot links for skills, on this host. */
export type BotShareSkillProject = { name: string; path: string }

type Source = {
  skills: ScannedSkill[]
  /** The folder every skill must really be in, since a link out of the home is the owner's, not the
   *  bot's; null for a project, whose linked-in skills (a setup script's) the bot loads as its own. */
  root: string | null
  /** Where a skill shows as from: its home path, or its project's name. */
  label: (folder: string) => string
  /** null: outside the home, so no file to open there. */
  homePath: (folder: string) => string | null
  /** A project's name when the skill's folder is outside the project; the owner ticks it to share. */
  optInFrom: (folder: string) => string | undefined
}

async function homeSources(
  bot: Pick<Bot, 'agent'>,
  home: Home,
  leftOut: BotShareLeftOut[],
  signal?: AbortSignal
): Promise<Source[]> {
  const own = await readBotOwnSkills(home.path, signal)
  const agentFirst: BotAgentSkillsFolder[] =
    bot.agent === 'claude' ? ['claude', 'agents'] : ['agents', 'claude']
  const folders: { folder: string; skills: ScannedSkill[] }[] = [
    { folder: BOT_OWN_SKILLS_FOLDER, skills: own.skills },
    ...agentFirst.map((found) => ({
      folder: BOT_AGENT_SKILLS_FOLDERS[found],
      skills: own.agentFound.filter((skill) => skill.found === found)
    }))
  ]
  const homePath = (folder: string) => relative(home.real, folder).split(sep).join('/')
  const sources: Source[] = []
  for (const { folder, skills } of folders) {
    if (skills.length === 0) {
      continue
    }
    const root = await ownPath(home, ...folder.split('/'))
    if (root === null || root === 'linked') {
      leftOut.push({ kind: 'skill', name: folder, why: 'linked' })
      continue
    }
    sources.push({ skills, root: root.own, label: homePath, homePath, optInFrom: () => undefined })
  }
  return sources
}

/** Linked projects' skills, scanned the way a chat's launch and Settings scan them. */
async function projectSources(
  projects: readonly BotShareSkillProject[],
  signal?: AbortSignal
): Promise<Source[]> {
  const sources = await Promise.all(
    projects.map(async (project): Promise<Source | null> => {
      const scanned = await scanSkillProject(project.path, signal)
      const real = await realpath(project.path).catch(() => null)
      if (!scanned || real === null) {
        return null
      }
      return {
        skills: scanned.skills,
        root: null,
        label: () => project.name,
        homePath: () => null,
        optInFrom: (folder) => (within(real, folder) ? undefined : project.name)
      }
    })
  )
  return sources.filter((source): source is Source => source !== null)
}

export async function readShareSkills(
  bot: Pick<Bot, 'agent'>,
  home: Home,
  leftOut: BotShareLeftOut[],
  projects: readonly BotShareSkillProject[] = [],
  /** Aborted when a newer read replaces this one: it stops walking and rejects. */
  signal?: AbortSignal
): Promise<BotShareSkill[]> {
  const sources = [
    ...(await homeSources(bot, home, leftOut, signal)),
    ...(await projectSources(projects, signal))
  ]
  const valid: { skill: ScannedSkill; source: Source }[] = []
  const refused: { folder: string; entry: BotShareLeftOut }[] = []
  for (const source of sources) {
    for (const skill of source.skills) {
      if (!validPartName(skill.name)) {
        refused.push({
          folder: skill.folder,
          entry: { kind: 'skill', name: skill.name, why: 'name' }
        })
      } else if (source.root !== null && !within(source.root, skill.folder)) {
        // Reached through a link out of this folder: the owner's, unless another folder holds it.
        refused.push({
          folder: skill.folder,
          entry: { kind: 'skill', name: skill.name, why: 'outside-home' }
        })
      } else {
        valid.push({ skill, source })
      }
    }
  }
  const seen = new Set<string>()
  const skills: BotShareSkill[] = []
  for (const { skill, source } of valid) {
    if (seen.has(skill.folder)) {
      continue
    }
    seen.add(skill.folder)
    if (skills.some((entry) => entry.name === skill.name)) {
      leftOut.push({
        kind: 'skill',
        name: skill.name,
        why: 'duplicate',
        from: source.label(skill.folder)
      })
    } else {
      skills.push({
        name: skill.name,
        description: skill.description,
        directory: skill.folder,
        homePath: source.homePath(skill.folder),
        ...optInField(source.optInFrom(skill.folder), skill.folder)
      })
    }
  }
  for (const { folder, entry } of refused) {
    if (!seen.has(folder)) {
      seen.add(folder)
      leftOut.push(entry)
    }
  }
  return withinLimit(await packable(skills, leftOut, signal), leftOut).sort((left, right) =>
    left.name.localeCompare(right.name, 'en-US')
  )
}

function optInField(
  project: string | undefined,
  folder: string
): Pick<BotShareSkill, 'optInFrom' | 'optInKey'> {
  if (project === undefined) {
    return {}
  }
  const optInKey = createHash('sha256').update(folder).digest('hex').slice(0, 32)
  return { optInFrom: project, optInKey }
}

/** The first skills a package can carry, the bot's own first; the rest are left out with why. */
function withinLimit(skills: BotShareSkill[], leftOut: BotShareLeftOut[]): BotShareSkill[] {
  for (const skill of skills.slice(BOT_PACKAGE_SKILLS_MAX)) {
    leftOut.push({ kind: 'skill', name: skill.name, why: 'limit' })
  }
  return skills.slice(0, BOT_PACKAGE_SKILLS_MAX)
}

/** How many skill folders are checked at once. */
const SHAPE_CHECKS_AT_ONCE = 4

/** The skills the packager would take: one it refuses (a link or a special file inside, too big) is
 *  left out with why, so it never stops the others from going out with the default picks. It checks
 *  shape only: no asset is read or hashed (discovery still reads each SKILL.md). Picked skills are
 *  read when packed, where one that can't be read is left out too. */
async function packable(
  skills: BotShareSkill[],
  leftOut: BotShareLeftOut[],
  signal?: AbortSignal
): Promise<BotShareSkill[]> {
  const refusals: (ReturnType<typeof unpackableWhy> | null)[] = []
  for (let start = 0; start < skills.length; start += SHAPE_CHECKS_AT_ONCE) {
    // A replaced read stops here, so a walk cut short is never taken for a refusal.
    signal?.throwIfAborted()
    const batch = skills.slice(start, start + SHAPE_CHECKS_AT_ONCE)
    refusals.push(
      ...(await Promise.all(
        batch.map((skill) =>
          checkSkillPackageShape(
            skill.directory,
            SKILL_PACKAGE_OBSERVATION_LIMITS,
            isNestedSkill,
            signal
          ).then(
            () => null,
            (error: unknown) => unpackableWhy(error)
          )
        )
      ))
    )
  }
  signal?.throwIfAborted()
  return skills.filter((skill, index) => {
    const why = refusals[index]
    if (why !== null) {
      leftOut.push({ kind: 'skill', name: skill.name, why })
    }
    return why === null
  })
}

/** Why the packager refused a skill folder, from its observer's error. */
export function unpackableWhy(error: unknown): 'link' | 'size' | 'unreadable' {
  const code = error instanceof Error ? error.message : ''
  if (code === 'skill-package-link' || code === 'skill-path-escape') {
    return 'link'
  }
  return code.endsWith('-limit') ? 'size' : 'unreadable'
}

/** A skill's own files: a folder inside it whose SKILL.md declares a name and description (the rule
 *  discovery admits a skill by) is another skill, listed or left out on its own, so it is skipped
 *  unread and never rides along in this one's preview or archive. Any other SKILL.md is a document. */
export async function ownSkillFiles(directory: string): Promise<ObservedSkillPackage['files']> {
  // `directory` is the real folder the listing checked, which may be older than this read: one no
  // longer at its own real path (a link put in place of it or a folder above it) is not that folder.
  if ((await realpath(directory)) !== directory) {
    throw new Error('skill-package-link')
  }
  const { files } = await observeSkillPackage(
    directory,
    SKILL_PACKAGE_OBSERVATION_LIMITS,
    undefined,
    undefined,
    process.platform,
    false,
    isNestedSkill
  )
  return files
}

/** A folder inside a skill that is a skill of its own: listed on its own, never read with this one. */
async function isNestedSkill(folder: string): Promise<boolean> {
  return (await admittedSkill(join(folder, 'SKILL.md'))) !== null
}
