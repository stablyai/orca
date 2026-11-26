import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { isNativeChatSkillForAgent } from '../../../shared/native-chat/input/commands/native-chat-skill-visibility'
import { linkedSkillProjects } from '../../bots/bot-skill-projects'
import { discoverSkills } from './skill-native-discovery'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-bot-linked-skills-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("a bot home's skill discovery", () => {
  it("lists the linked projects' skills its chats load, for Claude and Codex bots", async () => {
    const project = join(directory, 'project')
    await mkdir(join(project, '.claude', 'skills', 'ref-oss'), { recursive: true })
    await writeFile(
      join(project, '.claude', 'skills', 'ref-oss', 'SKILL.md'),
      '---\nname: ref-oss\ndescription: Look at reference repos\n---\n'
    )
    const home = join(directory, 'bot-home')
    await mkdir(home, { recursive: true })
    const linkedFolder = join(directory, 'linked')
    const repo = { id: 'repo-1', path: project, displayName: 'project' } as Repo
    await linkedSkillProjects({ skillProjects: [repo.id] }, [repo], linkedFolder)

    const result = await discoverSkills({
      homeDir: join(directory, 'user-home'),
      cwd: home,
      repos: [],
      linkedSkillsFolder: linkedFolder,
      refresh: true
    })

    for (const agent of ['claude', 'codex'] as const) {
      expect(
        result.skills
          .filter((skill) => isNativeChatSkillForAgent(agent, skill, result))
          .map((skill) => skill.name)
      ).toEqual(['ref-oss'])
    }
  })
})
