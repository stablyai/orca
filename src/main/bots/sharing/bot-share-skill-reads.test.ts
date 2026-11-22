import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

  it('stops a replaced read without recording anything', async () => {
    await write(home, 'skills/triage/SKILL.md', skillText('triage'))
    await write(project, '.agents/skills/deploy/SKILL.md', skillText('deploy'))
    const leftOut: BotShareLeftOut[] = []

    const read = readShareSkills(
      bot,
      { path: home, real: await realpath(home) },
      leftOut,
      [{ name: 'team-skills', path: project }],
      AbortSignal.abort()
    )

    await expect(read).rejects.toMatchObject({ name: 'AbortError' })
    expect(leftOut).toEqual([])
  })
})
