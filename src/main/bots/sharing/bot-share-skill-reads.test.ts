import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Every path looked up, and a test's hook for the next lookup of one path: it may fail the lookup,
 *  or move a link after it resolved. */
const lookups = vi.hoisted(() => ({
  paths: [] as string[],
  next: new Map<string, (resolve: () => Promise<string>) => Promise<string>>()
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return {
    ...fs,
    realpath: async (path: string) => {
      lookups.paths.push(path)
      const hook = lookups.next.get(path)
      lookups.next.delete(path)
      const resolve = () => fs.realpath(path)
      return hook ? hook(resolve) : resolve()
    }
  }
})
const notFound = async (): Promise<string> => {
  throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
}
import type { BotShareLeftOut } from '../../../shared/bots/bot-package'
import { BOT_SHARE_ERRORS } from '../../../shared/bots/bot-share-errors'
import type { Repo } from '../../../shared/repository/repo-types'
import { makeTestBot } from '../bot.test-fixture'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { BotShareCandidates } from './bot-package-export'
import { BotShareSkillReads, type BotShareSkillListing } from './bot-share-skill-reads'
import { readShareSkills } from './bot-share-skills'
import { readBotShareable } from './bot-share-sources'

const listing = (name: string): BotShareSkillListing => ({
  skills: [{ name, description: 'Steps', directory: `/skills/${name}`, homePath: null }],
  leftOut: []
})

/** A read that finishes when told to, and stops (rejecting) if aborted first, as a walk does. */
function walk() {
  let finish: (listing: BotShareSkillListing) => void = () => {}
  const stopped: AbortSignal[] = []
  const run = (signal: AbortSignal) =>
    new Promise<BotShareSkillListing>((resolve, reject) => {
      finish = resolve
      signal.addEventListener('abort', () => {
        stopped.push(signal)
        reject(signal.reason)
      })
    })
  return { run, stopped, finish: (value: BotShareSkillListing) => finish(value) }
}

// STA-16989: every pick walked every skill folder again; a replaced walk ran on.
describe('BotShareSkillReads', () => {
  it("stops a dialog's replaced read, which fails as prepare-again, and keeps the new one", async () => {
    const reads = new BotShareSkillReads()
    const opening = walk()
    const first = reads.read('dialog', 'sources', false, opening.run)
    // A pick while the dialog's first read runs waits for that read.
    const pick = reads.read('dialog', 'sources', true, async () => listing('unread'))

    const rebuilt = reads.read('dialog', 'sources', false, async () => listing('deploy'))

    await expect(first).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
    await expect(pick).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
    await expect(rebuilt).resolves.toEqual(listing('deploy'))
    expect(opening.stopped).toHaveLength(1)
    await expect(
      reads.read('dialog', 'sources', true, async () => listing('unread'))
    ).resolves.toEqual(listing('deploy'))
  })

  // A build's lookups before its read take any time, so the newer build may reach its read first.
  it('lets the newer build win when the older one reaches its read last', async () => {
    const reads = new BotShareSkillReads()
    const older = reads.forBuild('bot', { session: 'dialog' }).build
    const newer = reads.forBuild('bot', { session: 'dialog' }).build
    const opening = walk()

    const rebuilt = reads.read('bot/dialog', 'sources', false, opening.run, newer)
    const replaced = reads.read('bot/dialog', 'sources', false, async () => listing('old'), older)

    await expect(replaced).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
    opening.finish(listing('deploy'))
    await expect(rebuilt).resolves.toEqual(listing('deploy'))
    expect(opening.stopped).toEqual([])
  })

  it('fails an older build whose read finished after a newer build was asked for', async () => {
    const reads = new BotShareSkillReads()
    const older = reads.forBuild('bot', { session: 'dialog' }).build
    const opening = walk()
    const replaced = reads.read('bot/dialog', 'sources', false, opening.run, older)
    reads.forBuild('bot', { session: 'dialog' })
    // A pick doesn't replace the build whose listing it reuses.
    reads.forBuild('bot', { session: 'dialog', reuseSkills: true })

    opening.finish(listing('deploy'))
    await expect(replaced).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
  })

  // A pick resolves its sources before its read, so a pick asked earlier may reach it later.
  it('never lets an older pick stop or replace a newer build it reaches last', async () => {
    const reads = new BotShareSkillReads()
    const pick = reads.forBuild('bot', { session: 'dialog', reuseSkills: true }).build
    const newer = reads.forBuild('bot', { session: 'dialog' }).build
    const opening = walk()
    const rebuilt = reads.read('bot/dialog', 'now', false, opening.run, newer)

    const late = reads.read('bot/dialog', 'before', true, async () => listing('old'), pick)

    await expect(late).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
    opening.finish(listing('deploy'))
    await expect(rebuilt).resolves.toEqual(listing('deploy'))
    expect(opening.stopped).toEqual([])
    await expect(
      reads.read('bot/dialog', 'now', true, async () => listing('unread'))
    ).resolves.toEqual(listing('deploy'))
  })

  it('keeps only the dialogs opened most recently', async () => {
    const reads = new BotShareSkillReads()
    for (let index = 1; index <= 9; index += 1) {
      await reads.read(`dialog-${index}`, 'sources', false, async () => listing(`opened-${index}`))
    }

    const reread = async () => listing('reread')
    await expect(reads.read('dialog-1', 'sources', true, reread)).resolves.toEqual(
      listing('reread')
    )
    await expect(reads.read('dialog-9', 'sources', true, reread)).resolves.toEqual(
      listing('opened-9')
    )
  })
})

describe('a reused skill listing on disk', () => {
  let root: string
  let home: string
  let project: string
  const bot = makeTestBot({
    id: '3f2b6c1e-8d4a-4b7e-9c1f-5a6d7e8f9a0b',
    name: 'Release notes',
    skillProjects: ['team-skills']
  })
  const repos = (): Repo[] => [
    { id: 'team-skills', path: project, displayName: 'team-skills', badgeColor: '#000', addedAt: 0 }
  ]
  const write = async (folder: string, path: string, text: string): Promise<void> => {
    await mkdir(join(folder, path, '..'), { recursive: true })
    await writeFile(join(folder, path), text)
  }
  const skillText = (name: string): string =>
    `---\nname: ${name}\ndescription: Ship it\n---\nSteps.\n`

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-bot-share-skill-reads-test-'))
    useBotToolCredentialsRoot(join(root, 'credentials'))
    home = join(root, 'home')
    project = join(root, 'team-skills')
    await write(home, 'SOUL.md', '# Release notes\n')
  })

  afterEach(async () => {
    useBotToolCredentialsRoot(null)
    await rm(root, { recursive: true, force: true })
  })

  // A pick packs from the listing, so a folder swapped for a link since must not be followed.
  it.skipIf(process.platform === 'win32')(
    'leaves out a listed skill whose folder was swapped for a link before a pick packs it',
    async () => {
      await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy'))
      await write(root, 'elsewhere/deploy/SKILL.md', skillText('deploy'))
      await write(root, 'elsewhere/deploy/secret.txt', 'not the project')
      const skillReads = new BotShareSkillReads()
      const build = (reuseSkills: boolean) =>
        readBotShareable({
          bot,
          home,
          automations: [],
          repos: repos(),
          skillReads,
          session: 'dialog-1',
          reuseSkills
        })
      await build(false)
      await rm(join(project, '.agents/skills/deploy'), { recursive: true })
      await symlink(join(root, 'elsewhere/deploy'), join(project, '.agents/skills/deploy'))

      const candidates = new BotShareCandidates(join(root, 'candidates'))
      try {
        const summary = await candidates.prepare({
          bot,
          shareable: await build(true),
          selection: {},
          packageId: 'p'
        })
        expect(summary.bot.skills).toEqual([])
        expect(summary.leftOut).toContainEqual({ kind: 'skill', name: 'deploy', why: 'link' })
      } finally {
        await candidates.dispose()
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reads again on a pick when a linked project path now resolves to another folder',
    async () => {
      await write(root, 'checkouts/a/.agents/skills/alpha/SKILL.md', skillText('alpha'))
      await write(root, 'checkouts/b/.agents/skills/beta/SKILL.md', skillText('beta'))
      await symlink(join(root, 'checkouts/a'), project)
      const skillReads = new BotShareSkillReads()
      const build = async (reuseSkills: boolean) =>
        (
          await readBotShareable({
            bot,
            home,
            automations: [],
            repos: repos(),
            skillReads,
            session: 'dialog-1',
            reuseSkills
          })
        ).skills.map((skill) => skill.name)
      await expect(build(false)).resolves.toEqual(['alpha'])
      await rm(project)
      await symlink(join(root, 'checkouts/b'), project)

      await expect(build(true)).resolves.toEqual(['beta'])
    }
  )

  describe('a linked project behind a link', () => {
    let skillReads: BotShareSkillReads
    let walks: number
    /** The dialog's skills, building afresh or as a pick. */
    const build = async (reuseSkills: boolean): Promise<string[]> =>
      (
        await readBotShareable({
          bot,
          home,
          automations: [],
          repos: repos(),
          skillReads,
          session: 'dialog-1',
          reuseSkills
        })
      ).skills.map((skill) => skill.name)
    const pointAt = async (checkout: string): Promise<void> => {
      await rm(project, { force: true })
      await symlink(join(root, 'checkouts', checkout), project)
    }

    beforeEach(async () => {
      for (const name of ['alpha', 'beta', 'gamma']) {
        await write(root, `checkouts/${name}/.agents/skills/${name}/SKILL.md`, skillText(name))
      }
      await pointAt('alpha')
      skillReads = new BotShareSkillReads()
      walks = 0
      const read = skillReads.read.bind(skillReads)
      skillReads.read = (session, sources, reuse, run, place) =>
        read(
          session,
          sources,
          reuse,
          (signal) => {
            walks += 1
            return run(signal)
          },
          place
        )
      lookups.paths.length = 0
      lookups.next.clear()
    })

    it.skipIf(process.platform === 'win32')(
      'reuses the listing on a pick, looking the project up once per build',
      async () => {
        await expect(build(false)).resolves.toEqual(['alpha'])
        await expect(build(true)).resolves.toEqual(['alpha'])

        expect(walks).toBe(1)
        expect(lookups.paths.filter((path) => path === project)).toHaveLength(2)
      }
    )

    it.skipIf(process.platform === 'win32')(
      'never keeps or reuses a listing read while the project could not be looked up',
      async () => {
        await build(false)
        await pointAt('beta')
        lookups.next.set(project, notFound)
        await build(true)
        await pointAt('gamma')
        lookups.next.set(project, notFound)

        await expect(build(true)).resolves.toEqual([])
        await expect(build(true)).resolves.toEqual(['gamma'])
      }
    )

    it.skipIf(process.platform === 'win32')(
      'keeps a listing under the folder it was read from when the link moves back meanwhile',
      async () => {
        await build(false)
        await pointAt('beta')
        lookups.next.set(project, async (resolve) => {
          const real = await resolve()
          await pointAt('alpha')
          return real
        })
        await build(true)
        await pointAt('beta')

        await expect(build(true)).resolves.toEqual(['beta'])
      }
    )
  })

  it('stops a replaced read without recording anything', async () => {
    await write(home, 'skills/triage/SKILL.md', skillText('triage'))
    await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy'))
    const leftOut: BotShareLeftOut[] = []

    const read = readShareSkills(
      bot,
      { path: home, real: await realpath(home) },
      leftOut,
      [{ name: 'team-skills', path: project, real: project }],
      AbortSignal.abort()
    )

    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(leftOut).toEqual([])
  })
})
