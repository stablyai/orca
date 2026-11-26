import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { isNativeChatSkillForAgent } from '../../../shared/native-chat/input/commands/native-chat-skill-visibility'
import {
  botLinkedSkillsFolder,
  linkedSkillProjects,
  relinkBotSkills
} from '../../bots/bot-skill-projects'
import { discoverSkills } from './skill-native-discovery'

const paths = vi.hoisted(() => ({ userData: '' }))
vi.mock('../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => paths.userData
}))

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-bot-linked-skills-'))
  paths.userData = join(directory, 'user-data')
})

async function writeProjectSkill(): Promise<Repo> {
  const project = join(directory, 'project')
  await mkdir(join(project, '.claude', 'skills', 'ref-oss'), { recursive: true })
  await writeFile(
    join(project, '.claude', 'skills', 'ref-oss', 'SKILL.md'),
    '---\nname: ref-oss\ndescription: Look at reference repos\n---\n'
  )
  return { id: 'repo-1', path: project, displayName: 'project', badgeColor: '#000', addedAt: 0 }
}

async function homeSkillNames(linkedSkillsFolder: string, agent: 'claude' | 'codex') {
  const home = join(directory, 'bot-home')
  await mkdir(home, { recursive: true })
  // No refresh: a picker open reads the shared root-scan cache.
  const result = await discoverSkills({
    homeDir: join(directory, 'user-home'),
    cwd: home,
    repos: [],
    linkedSkillsFolder
  })
  return result.skills
    .filter((skill) => isNativeChatSkillForAgent(agent, skill, result))
    .map((skill) => skill.name)
}

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("a bot home's skill discovery", () => {
  it("lists the linked projects' skills its chats load, for Claude and Codex bots", async () => {
    const repo = await writeProjectSkill()
    const linkedFolder = join(directory, 'linked')
    await linkedSkillProjects({ skillProjects: [repo.id] }, [repo], linkedFolder)

    for (const agent of ['claude', 'codex'] as const) {
      expect(await homeSkillNames(linkedFolder, agent)).toEqual(['ref-oss'])
    }
  })

  it('drops an unlinked project at the next scan, not after the cache expires', async () => {
    const repo = await writeProjectSkill()
    const bot = { id: 'bot-1', folderWorkspaceId: 'home-1', skillProjects: [repo.id] }
    const linkedFolder = botLinkedSkillsFolder(bot.id)
    await relinkBotSkills(bot, [repo])
    expect(await homeSkillNames(linkedFolder, 'claude')).toEqual(['ref-oss'])

    await relinkBotSkills({ ...bot, skillProjects: [] }, [repo])

    expect(await homeSkillNames(linkedFolder, 'claude')).toEqual([])
  })
})
