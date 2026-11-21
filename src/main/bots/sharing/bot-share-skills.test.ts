import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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

  it.skipIf(process.platform === 'win32')(
    'lists a skill the project links in from outside itself, for the owner to tick',
    async () => {
      await write(root, 'devex/electron/SKILL.md', skillText('electron', 'Drive the app'))
      await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy', 'Ship it'))
      await symlink(join(root, 'devex/electron'), join(project, '.agents/skills/electron'))

      const shareable = await read()
      expect(shareable.skills.map(({ name, optInFrom }) => ({ name, optInFrom }))).toEqual([
        { name: 'deploy', optInFrom: undefined },
        { name: 'electron', optInFrom: 'team-skills' }
      ])

      const candidates = new BotShareCandidates(join(root, 'candidates'))
      const byDefault = await candidates.prepare({
        bot,
        shareable,
        selection: {},
        packageId: 'package-1'
      })
      expect(byDefault.bot.skills.map((skill) => skill.name)).toEqual(['deploy'])
      expect(byDefault.available.skills).toContainEqual(
        expect.objectContaining({ name: 'electron', optInFrom: 'team-skills' })
      )
      const key = shareable.skills.find((skill) => skill.name === 'electron')?.optInKey ?? ''
      const ticked = await candidates.prepare({
        bot,
        shareable,
        selection: { skills: ['deploy', 'electron'], outsideSkills: [{ name: 'electron', key }] },
        packageId: 'package-1'
      })
      expect(ticked.bot.skills.map((skill) => skill.name)).toEqual(['deploy', 'electron'])
      expect(ticked.files.map((file) => file.path)).toContain('skills/electron/SKILL.md')
      await candidates.dispose()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'leaves out a skill with a link inside, so the others still share by default',
    async () => {
      await write(home, 'skills/notes/SKILL.md', skillText('notes', 'Own skill'))
      await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy', 'Ship it'))
      await write(project, 'README.md', 'Project readme\n')
      await symlink(join(project, 'README.md'), join(project, '.agents/skills/deploy/README.md'))

      const shareable = await read()
      expect(shareable.skills.map((skill) => skill.name)).toEqual(['notes'])
      expect(shareable.leftOut).toContainEqual({
        kind: 'skill',
        name: 'deploy',
        why: 'link'
      })

      const candidates = new BotShareCandidates(join(root, 'candidates'))
      const summary = await candidates.prepare({
        bot,
        shareable,
        selection: {},
        packageId: 'package-1'
      })
      expect(summary.bot.skills.map((skill) => skill.name)).toEqual(['notes'])
      expect(summary.files.map((file) => file.path)).toContain('skills/notes/SKILL.md')
      expect(summary.files.some((file) => file.path.startsWith('skills/deploy/'))).toBe(false)
      await candidates.dispose()
    }
  )

  it('leaves out a skill with a hard-linked file, for the same reason', async () => {
    await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy', 'Ship it'))
    await write(project, 'notes.md', 'Shared notes\n')
    await link(join(project, 'notes.md'), join(project, '.agents/skills/deploy/notes.md'))

    const shareable = await read()
    expect(shareable.skills).toEqual([])
    expect(shareable.leftOut).toContainEqual({
      kind: 'skill',
      name: 'deploy',
      why: 'link'
    })
  })

  // A file no one can read stands in for a read: listing the skill and preparing without it must not
  // open its assets, only look at their shape.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "reads no skill's assets to list it, and none of one it isn't packing",
    async () => {
      await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy', 'Ship it'))
      await write(project, '.agents/skills/deploy/big.md', 'Large reference\n')
      await chmod(join(project, '.agents/skills/deploy/big.md'), 0o000)

      const shareable = await read()
      expect(shareable.skills.map((skill) => skill.name)).toEqual(['deploy'])

      const candidates = new BotShareCandidates(join(root, 'candidates'))
      const summary = await candidates.prepare({
        bot,
        shareable,
        selection: { skills: [] },
        packageId: 'package-1'
      })
      expect(summary.bot.skills).toEqual([])
      expect(summary.available.skills.map((skill) => skill.name)).toEqual(['deploy'])
      await candidates.dispose()
    }
  )

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    "leaves out a picked skill it can't read, and shares the rest by default",
    async () => {
      await write(home, 'skills/notes/SKILL.md', skillText('notes', 'Own skill'))
      await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy', 'Ship it'))
      await write(project, '.agents/skills/deploy/big.md', 'Large reference\n')
      await chmod(join(project, '.agents/skills/deploy/big.md'), 0o000)
      // A nested SKILL.md no one can read: not admitted as a skill, so read as this one's document.
      await write(project, '.agents/skills/guide/SKILL.md', skillText('guide', 'How to'))
      await write(project, '.agents/skills/guide/part/SKILL.md', skillText('part', 'Nested'))
      await chmod(join(project, '.agents/skills/guide/part/SKILL.md'), 0o000)

      const shareable = await read()
      expect(shareable.skills.map((skill) => skill.name)).toEqual(['deploy', 'guide', 'notes'])

      const candidates = new BotShareCandidates(join(root, 'candidates'))
      const summary = await candidates.prepare({
        bot,
        shareable,
        selection: {},
        packageId: 'package-1'
      })
      expect(summary.bot.skills.map((skill) => skill.name)).toEqual(['notes'])
      expect(summary.files.map((file) => file.path)).toContain('skills/notes/SKILL.md')
      expect(
        summary.files.some(
          (file) => !file.path.startsWith('skills/notes/') && file.path.startsWith('skills/')
        )
      ).toBe(false)
      expect(summary.available.skills.map((skill) => skill.name)).toEqual(['notes'])
      expect(summary.leftOut).toEqual(
        expect.arrayContaining([
          { kind: 'skill', name: 'deploy', why: 'unreadable' },
          { kind: 'skill', name: 'guide', why: 'unreadable' }
        ])
      )
      // The candidate keeps the bot's own view of its parts, for opening them.
      expect(candidates.get(summary.candidateId)!.shareable.skills).toHaveLength(3)
      await candidates.dispose()
    }
  )

  it('still prepares a bot with more skills than a package carries, own ones first', async () => {
    await write(home, 'skills/notes/SKILL.md', skillText('notes', 'Own skill'))
    for (let index = 0; index < 65; index += 1) {
      const name = `skill-${String(index).padStart(2, '0')}`
      await write(project, `.agents/skills/${name}/SKILL.md`, skillText(name, 'Project skill'))
    }

    const shareable = await read()
    expect(shareable.skills).toHaveLength(64)
    expect(shareable.skills.map((skill) => skill.name)).toContain('notes')
    expect(shareable.leftOut.filter((entry) => entry.why === 'limit')).toHaveLength(2)

    const candidates = new BotShareCandidates(join(root, 'candidates'))
    const summary = await candidates.prepare({ bot, shareable, selection: {}, packageId: 'p' })
    expect(summary.bot.skills).toHaveLength(64)
    await candidates.dispose()
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
