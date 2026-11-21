import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { makeTestBot } from '../bot.test-fixture'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { BotShareCandidates, type BotShareSelection } from './bot-package-export'
import { restoredPicks, savedPicks } from './bot-share-outside-picks'
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

/** The skill electron, linked into the project from `folder` outside it. */
async function linkElectronIn(folder = 'devex'): Promise<void> {
  await write(root, `${folder}/electron/SKILL.md`, skillText('electron', 'Drive the app'))
  await rm(join(project, '.agents/skills/electron'), { recursive: true, force: true })
  await symlink(join(root, folder, 'electron'), join(project, '.agents/skills/electron'))
}

/** The owner's tick on electron, as the dialog sends it for the folder it shows. */
function tick(shareable: BotShareable): BotShareSelection {
  const key = shareable.skills.find((skill) => skill.name === 'electron')?.optInKey
  return { skills: ['deploy', 'electron'], outsideSkills: key ? [{ name: 'electron', key }] : [] }
}

const BOTH = ['skills/deploy/SKILL.md', 'skills/electron/SKILL.md']
const DEPLOY = ['skills/deploy/SKILL.md']

describe('a skill linked into a project from outside it', () => {
  it('is named for its project and left out until ticked, even when the project has no name', async () => {
    await linkElectronIn()
    const shareable = await read('')
    expect(shareable.skills.find((skill) => skill.name === 'electron')?.optInFrom).toBe(
      'team-skills'
    )
    expect(await packed(shareable, {})).toEqual(DEPLOY)
    expect(await packed(shareable, tick(shareable))).toEqual(BOTH)
  })

  it('stays out of every rebuild after it moves outside, until the owner ticks it there', async () => {
    await write(project, '.agents/skills/electron/SKILL.md', skillText('electron', 'Old copy'))
    const names = { skills: ['deploy', 'electron'] }
    expect(await packed(await read(), names)).toEqual(BOTH)

    await linkElectronIn()
    const shareable = await read()
    // Unrelated toggles and Retry send the same names again.
    expect(await packed(shareable, names)).toEqual(DEPLOY)
    expect(await packed(shareable, names)).toEqual(DEPLOY)
    expect(await packed(shareable, tick(shareable))).toEqual(BOTH)
  })

  it('takes a first tick with no candidate before it, as after expiry or a failed build', async () => {
    await linkElectronIn()
    const shareable = await read()
    expect(await packed(shareable, tick(shareable))).toEqual(BOTH)
  })

  it('drops a tick once the skill is linked in from another folder', async () => {
    await linkElectronIn('devex')
    const ticked = tick(await read())
    await linkElectronIn('elsewhere')
    expect(await packed(await read(), ticked)).toEqual(DEPLOY)
  })
})

describe('saved picks for Update link', () => {
  async function published(selection: BotShareSelection) {
    const shareable = await read()
    const summary = await candidates.prepare({ bot, shareable, selection, packageId: 'p' })
    return savedPicks(candidates.get(summary.candidateId)!)
  }

  it('keeps an outside tick while the skill is linked in from that folder', async () => {
    await linkElectronIn()
    const saved = await published(tick(await read()))
    const last = restoredPicks(saved, await read())
    expect(last.selection).toEqual(saved.selection)
    expect(await packed(await read(), last.selection)).toEqual(BOTH)
  })

  it('drops the tick when it moved, and a skill no longer there', async () => {
    await linkElectronIn()
    const saved = await published({ ...tick(await read()), skills: ['deploy', 'electron', 'gone'] })
    await linkElectronIn('elsewhere')
    const last = restoredPicks(saved, await read())
    expect(last.selection).toEqual({ skills: ['deploy', 'electron'], outsideSkills: [] })
    expect(await packed(await read(), last.selection)).toEqual(DEPLOY)
  })
})
