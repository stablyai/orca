import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { makeTestBot } from '../bot.test-fixture'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { BotShareCandidates } from './bot-package-export'
import { botSharePartFiles } from './bot-share-part-view'
import { readBotShareable } from './bot-share-sources'

let root: string
let home: string
let project: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bot-share-skills-test-'))
  useBotToolCredentialsRoot(join(root, 'credentials'))
  home = join(root, 'home')
  project = join(root, 'team-skills')
  await write(home, 'SOUL.md', '# Release notes\n')
})

afterEach(async () => {
  useBotToolCredentialsRoot(null)
  await rm(root, { recursive: true, force: true })
})

const bot = makeTestBot({
  id: '3f2b6c1e-8d4a-4b7e-9c1f-5a6d7e8f9a0b',
  name: 'Release notes',
  skillProjects: ['team-skills', 'on-a-server']
})

function repos(): Repo[] {
  const repo = (id: string, path: string, extra: Partial<Repo> = {}): Repo => ({
    id,
    path,
    displayName: id,
    badgeColor: '#000',
    addedAt: 0,
    ...extra
  })
  return [
    repo('team-skills', project),
    repo('on-a-server', join(root, 'remote'), { connectionId: 'gpu-box' }),
    repo('not-linked', join(root, 'not-linked'))
  ]
}

async function write(folder: string, path: string, text: string): Promise<void> {
  await mkdir(join(folder, path, '..'), { recursive: true })
  await writeFile(join(folder, path), text)
}

const skillText = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`

const read = () => readBotShareable({ bot, home, automations: [], repos: repos() })

describe("a bot's linked projects' skills in the Share dialog", () => {
  it('offers and packs the skills of its linked projects on this computer', async () => {
    await write(project, '.agents/skills/triage/SKILL.md', skillText('triage', 'Sort issues'))
    await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy', 'Ship it'))
    await write(root, 'remote/.agents/skills/far/SKILL.md', skillText('far', 'Another host'))
    await write(root, 'not-linked/.agents/skills/other/SKILL.md', skillText('other', 'Not linked'))

    const shareable = await read()
    // No home file to open: the skill lives in the project.
    expect(shareable.skills.map(({ name, homePath }) => ({ name, homePath }))).toEqual([
      { name: 'deploy', homePath: null },
      { name: 'triage', homePath: null }
    ])

    const candidates = new BotShareCandidates(join(root, 'candidates'))
    const summary = await candidates.prepare({
      bot,
      shareable,
      selection: {},
      packageId: 'package-1'
    })
    expect(summary.bot.skills.map((skill) => skill.name)).toEqual(['deploy', 'triage'])
    expect(summary.files.map((file) => file.path)).toEqual(
      expect.arrayContaining(['skills/deploy/SKILL.md', 'skills/triage/SKILL.md'])
    )
    const candidate = candidates.get(summary.candidateId)!
    expect(await botSharePartFiles(candidate.shareable, 'skill:triage', candidate)).toEqual([
      expect.objectContaining({ path: 'SKILL.md', homePath: null })
    ])
    await candidates.dispose()
  })

  it('offers a skill the project links in, as the bot loads it', async () => {
    await write(root, 'devex/electron/SKILL.md', skillText('electron', 'Drive the app'))
    await mkdir(join(project, '.agents/skills'), { recursive: true })
    await symlink(join(root, 'devex/electron'), join(project, '.agents/skills/electron'))

    const shareable = await read()
    expect(shareable.skills.map((skill) => skill.name)).toEqual(['electron'])
  })

  it("keeps the bot's own skill when a linked project has one of the same name", async () => {
    await write(home, 'skills/triage/SKILL.md', skillText('triage', 'Own copy'))
    await write(project, '.agents/skills/triage/SKILL.md', skillText('triage', 'Project copy'))

    const shareable = await read()
    expect(shareable.skills).toEqual([
      expect.objectContaining({
        name: 'triage',
        description: 'Own copy',
        homePath: 'skills/triage'
      })
    ])
    expect(shareable.leftOut).toContainEqual({
      kind: 'skill',
      name: 'triage',
      why: 'duplicate',
      from: 'team-skills'
    })
  })
})
