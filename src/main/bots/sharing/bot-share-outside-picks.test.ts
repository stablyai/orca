import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BotSharePicks } from '../../../shared/bots/bot-share-picks'
import type { Repo } from '../../../shared/repository/repo-types'
import { makeTestBot } from '../bot.test-fixture'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { BotShareCandidates, type BotShareSelection } from './bot-package-export'
import { outsideSkillPicks, restoredPicks } from './bot-share-outside-picks'
import { readBotShareable, type BotShareable } from './bot-share-sources'

let root: string
let home: string
let project: string
let candidates: BotShareCandidates

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bot-share-outside-test-'))
  useBotToolCredentialsRoot(join(root, 'credentials'))
  home = join(root, 'home')
  project = join(root, 'team-skills')
  candidates = new BotShareCandidates(join(root, 'candidates'))
  await write(home, 'SOUL.md', '# Release notes\n')
  await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy', 'Ship it'))
})

afterEach(async () => {
  await candidates.dispose()
  useBotToolCredentialsRoot(null)
  await rm(root, { recursive: true, force: true })
})

const bot = makeTestBot({
  id: '3f2b6c1e-8d4a-4b7e-9c1f-5a6d7e8f9a0b',
  name: 'Release notes',
  skillProjects: ['team-skills']
})

async function write(folder: string, path: string, text: string): Promise<void> {
  await mkdir(join(folder, path, '..'), { recursive: true })
  await writeFile(join(folder, path), text)
}

const skillText = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\nSteps.\n`

const read = (displayName = 'team-skills') => {
  const repo: Repo = {
    id: 'team-skills',
    path: project,
    displayName,
    badgeColor: '#000',
    addedAt: 0
  }
  return readBotShareable({ bot, home, automations: [], repos: [repo] })
}

async function packed(shareable: BotShareable, selection: BotShareSelection): Promise<string[]> {
  const summary = await candidates.prepare({ bot, shareable, selection, packageId: 'package-1' })
  return summary.files.map((file) => file.path).filter((path) => path.startsWith('skills/'))
}

/** The skill electron, linked into the project from a folder outside it. */
async function linkElectronIn(): Promise<void> {
  await write(root, 'devex/electron/SKILL.md', skillText('electron', 'Drive the app'))
  await symlink(join(root, 'devex/electron'), join(project, '.agents/skills/electron'))
}

describe('a skill linked into a project from outside it', () => {
  it('is named for its project and left out by default even when the project has no name', async () => {
    await linkElectronIn()
    const shareable = await read('')
    expect(shareable.skills.find((skill) => skill.name === 'electron')?.optInFrom).toBe(
      'team-skills'
    )
    expect(await packed(shareable, {})).toEqual(['skills/deploy/SKILL.md'])
    expect(await packed(shareable, { skills: ['deploy', 'electron'] })).toContain(
      'skills/electron/SKILL.md'
    )
  })

  it('starts unticked on Update link once a skill picked inside the project is linked in from outside', async () => {
    await write(project, '.agents/skills/electron/SKILL.md', skillText('electron', 'Old copy'))
    const before = await read()
    const saved: BotSharePicks = {
      selection: { skills: ['deploy', 'electron'] },
      setupNote: '',
      outsideSkills: outsideSkillPicks(['deploy', 'electron'], before)
    }
    expect(saved.outsideSkills).toBeUndefined()

    await rm(join(project, '.agents/skills/electron'), { recursive: true })
    await linkElectronIn()
    const after = await read()
    const last = restoredPicks(saved, after)
    expect(last.selection.skills).toEqual(['deploy'])
    expect(await packed(after, last.selection)).toEqual(['skills/deploy/SKILL.md'])
  })

  it('keeps an outside skill the owner ticked, from the same folder, on Update link', async () => {
    await linkElectronIn()
    const shareable = await read()
    const saved: BotSharePicks = {
      selection: { skills: ['deploy', 'electron'] },
      setupNote: '',
      outsideSkills: outsideSkillPicks(['deploy', 'electron'], shareable)
    }
    expect(saved.outsideSkills).toEqual([
      { name: 'electron', directory: join(await realpath(root), 'devex/electron') }
    ])
    const last = restoredPicks(saved, await read())
    expect(last.selection.skills).toEqual(['deploy', 'electron'])
    expect(await packed(shareable, last.selection)).toContain('skills/electron/SKILL.md')

    // Ticked from one folder, now linked in from another: the owner ticks it again.
    const moved = restoredPicks(
      { ...saved, outsideSkills: [{ name: 'electron', directory: join(root, 'elsewhere') }] },
      shareable
    )
    expect(moved.selection.skills).toEqual(['deploy'])
  })
})
