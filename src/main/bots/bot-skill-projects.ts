// The projects a bot links for skills: which skills each has, read on this host, and the bot's one
// skill-only folder its chats load them from.
import { lstat, mkdir, open, readdir, realpath, rm, symlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Bot } from '../../shared/bot-types'
import type { BotSkillProjectView } from '../../shared/bots/bot-skill-projects'
import type { Repo } from '../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import { skillDirectoryMaxDepth } from '../../shared/skills/discovery/skill-discovery-depth'
import { declaredSkillMetadata } from '../../shared/skills/discovery/skill-metadata'
import { findSkillFiles } from '../skills/discovery/skill-root-file-walk'
import type {
  LinkedProjectSkill,
  LinkedSkillListing,
  LinkedSkills
} from '../native-chat/native-chat-skill-roots'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { retireAtRestCommandContext } from '../native-chat/agent-session-wire/options/at-rest-command-context'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

/** Where a project keeps skills for every agent, then Claude's own folder. */
const SKILL_FOLDERS = ['.agents', '.claude'] as const
const MAX_SKILL_FILE_BYTES = 256 * 1024

/** An admitted skill, with the real folder its link in Orca's folder points to. */
export type ScannedSkill = LinkedProjectSkill & { folder: string }

type ScannedProject = { skillsDir: string; skills: ScannedSkill[] }

/** A file's text, up to the cap; null when it can't be read. */
async function readCapped(path: string): Promise<string | null> {
  try {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min((await file.stat()).size, MAX_SKILL_FILE_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

/** A skill folder (team setup scripts link them in) holding a real SKILL.md that declares its name
 *  and description. A SKILL.md that is itself a link could be any file, so it never counts. */
export async function admittedSkill(skillFile: string): Promise<ScannedSkill | null> {
  const entry = await lstat(skillFile).catch(() => null)
  if (!entry?.isFile()) {
    return null
  }
  const folder = await realpath(dirname(skillFile)).catch(() => null)
  const text = folder ? await readCapped(join(folder, 'SKILL.md')) : null
  const declared = text === null ? null : declaredSkillMetadata(text)
  if (!folder || !declared) {
    return null
  }
  const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim()
  return {
    name: oneLine(declared.name),
    description: oneLine(declared.description),
    skillFile: join(folder, 'SKILL.md'),
    folder
  }
}

export async function scanSkillsFolder(
  skillsDir: string,
  signal?: AbortSignal
): Promise<ScannedSkill[]> {
  const files = await findSkillFiles(skillsDir, skillDirectoryMaxDepth('repo'), signal)
  signal?.throwIfAborted()
  const admitted = await Promise.all(files.map(admittedSkill))
  const byFolder = new Map<string, ScannedSkill>()
  for (const skill of admitted) {
    if (skill && !byFolder.has(skill.folder)) {
      byFolder.set(skill.folder, skill)
    }
  }
  return [...byFolder.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The project's skills from .agents/skills, else .claude/skills; null when it has none. */
export async function scanSkillProject(
  repoPath: string,
  signal?: AbortSignal
): Promise<ScannedProject | null> {
  for (const folder of SKILL_FOLDERS) {
    const skillsDir = join(repoPath, folder, 'skills')
    const skills = await scanSkillsFolder(skillsDir, signal)
    if (skills.length > 0) {
      return { skillsDir, skills }
    }
  }
  return null
}

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'project'

/** A bot's one linked-skills folder, outside its home: every chat of the bot loads it at launch. */
export function botLinkedSkillsFolder(botId: string): string {
  return join(getProfileUserDataPath(), 'bot-linked-skills', safeName(botId))
}

/** Each skills folder's link name for every skill, unique across the bot's projects even where
 *  the filesystem ignores case (macOS, Windows), so `deploy` and `Deploy` both get a link. */
function skillLinks(skills: readonly ScannedSkill[]): Map<string, string> {
  const links = new Map<string, string>()
  const taken = new Set<string>()
  for (const skill of skills) {
    const base = safeName(basename(skill.folder))
    let link = base
    for (let n = 2; taken.has(link.toLowerCase()); n += 1) {
      link = `${base}-${n}`
    }
    taken.add(link.toLowerCase())
    links.set(link, skill.folder)
  }
  return links
}

/** Makes one skills folder hold exactly these links, in place, so an agent watching it sees the
 *  change; anything there that isn't a link is left alone. */
async function syncLinks(skillsDir: string, links: ReadonlyMap<string, string>): Promise<void> {
  await mkdir(skillsDir, { recursive: true })
  const present = new Set<string>()
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) {
      continue
    }
    const path = join(skillsDir, entry.name)
    const target = links.get(entry.name)
    if (target !== undefined && (await realpath(path).catch(() => null)) === target) {
      present.add(entry.name)
    } else {
      await rm(path, { force: true })
    }
  }
  for (const [link, target] of links) {
    if (present.has(link)) {
      continue
    }
    const path = join(skillsDir, link)
    await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir').catch(
      async (error: NodeJS.ErrnoException) => {
        // Taken counts only when it is this link (another Orca process made it); anything else
        // there is left alone, and the sync fails so the chat gets the list instead.
        if (error.code !== 'EEXIST' || (await realpath(path).catch(() => null)) !== target) {
          throw error
        }
      }
    )
  }
}

const syncing = new Map<string, Promise<unknown>>()

/** One scan-and-sync per folder at a time, in call order, so an older scan never lands over a
 *  newer one's links. */
function serialized<T>(folder: string, run: () => Promise<T>): Promise<T> {
  const next = (syncing.get(folder) ?? Promise.resolve()).catch(() => {}).then(run)
  syncing.set(folder, next)
  return next.finally(() => {
    if (syncing.get(folder) === next) {
      syncing.delete(folder)
    }
  })
}

function isLocalRepo(repo: Repo): boolean {
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

/** These linked projects that are on this host, the only ones a bot loads skills from. */
export function localSkillProjects(ids: readonly string[], repos: readonly Repo[]): Repo[] {
  return ids.flatMap((id) => {
    const repo = repos.find((entry) => entry.id === id)
    return repo && isLocalRepo(repo) ? [repo] : []
  })
}

/** These linked projects on this host that have skills, scanned in place. */
async function scanLinkedProjects(
  ids: readonly string[],
  repos: readonly Repo[]
): Promise<{ repo: Repo; skills: ScannedSkill[] }[]> {
  const scanned = await Promise.all(
    localSkillProjects(ids, repos).map(async (repo) => {
      const project = await scanSkillProject(repo.path)
      return project ? [{ repo, skills: project.skills }] : []
    })
  )
  return scanned.flat()
}

/** These linked projects' skills, read in place for a running chat's list; no folder is touched. */
export async function linkedSkillListing(
  ids: readonly string[],
  repos: readonly Repo[]
): Promise<LinkedSkillListing[]> {
  return (await scanLinkedProjects(ids, repos)).map(({ repo, skills }) => ({
    name: repo.displayName,
    skills: skills.map(({ folder: _folder, ...skill }) => skill)
  }))
}

/**
 * The bot's linked projects on this host that have skills, with its folder brought up to date: a
 * link per admitted skill under skills/ (plugin-folder agents, Codex, OpenCode) and .claude/skills/
 * (Claude, as an added directory), and none of the projects' settings, plugins, commands or
 * instructions. Kept in place, so a running Claude or Codex loads a linked project's skills, and
 * drops an unlinked one's, without a restart.
 */
export async function linkedSkillProjects(
  bot: Pick<Bot, 'skillProjects'>,
  repos: readonly Repo[],
  folder: string
): Promise<LinkedSkills> {
  // Rejects when the folder can't be brought up to date, so no caller takes a partial list.
  const scanned = await serialized(folder, async () => {
    const projects = await scanLinkedProjects(bot.skillProjects ?? [], repos)
    const links = skillLinks(projects.flatMap((project) => project.skills))
    await syncLinks(join(folder, 'skills'), links)
    await syncLinks(join(folder, '.claude', 'skills'), links)
    return projects
  })
  return {
    root: { skillsRoot: join(folder, 'skills'), pluginDir: folder, linksOut: true },
    projects: scanned.map(({ repo, skills }) => ({
      name: repo.displayName,
      repoPath: repo.path,
      skills: skills.map(({ folder: _folder, ...skill }) => skill)
    }))
  }
}

/** The bot's links changed: its open chats load the skills before their next turn, and its resting
 *  chats' and item comments' `/` menus reread them. */
export function relinkBotSkills(
  bot: Pick<Bot, 'id' | 'skillProjects' | 'folderWorkspaceId'>,
  repos: readonly Repo[]
): Promise<void> {
  return linkedSkillProjects(bot, repos, botLinkedSkillsFolder(bot.id))
    .then(
      () => {},
      (error: unknown) => {
        // The folder keeps its last links, which the bot's chats and `/` menus still load.
        console.warn("[bots] the bot's linked project skills could not be relinked", bot.id, error)
      }
    )
    .finally(async () => {
      const { clearSkillDiscoveryCaches } =
        await import('../skills/discovery/skill-discovery-target')
      clearSkillDiscoveryCaches()
      retireAtRestCommandContext(folderWorkspaceKey(bot.folderWorkspaceId))
    })
}

/** Projects as Settings shows them, from the same scan a chat's launch uses. */
export async function botSkillProjectViews(
  repoIds: readonly string[],
  repos: readonly Repo[]
): Promise<BotSkillProjectView[]> {
  return Promise.all(
    repoIds.map(async (repoId): Promise<BotSkillProjectView> => {
      const repo = repos.find((entry) => entry.id === repoId)
      if (!repo) {
        return { repoId, name: repoId, status: 'missing', skillsDir: null, skills: [] }
      }
      if (!isLocalRepo(repo)) {
        return { repoId, name: repo.displayName, status: 'remote', skillsDir: null, skills: [] }
      }
      const scanned = await scanSkillProject(repo.path)
      return {
        repoId,
        name: repo.displayName,
        status: 'local',
        skillsDir: scanned?.skillsDir ?? null,
        skills: (scanned?.skills ?? []).map(({ name, description }) => ({ name, description }))
      }
    })
  )
}
