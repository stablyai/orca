import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeTestBot } from '../bot.test-fixture'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { BotShareCandidates } from './bot-package-export'
import { botSharePartFiles } from './bot-share-part-view'
import { readBotShareable } from './bot-share-sources'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bot-share-view-test-'))
  useBotToolCredentialsRoot(join(root, 'credentials'))
})

afterEach(async () => {
  useBotToolCredentialsRoot(null)
  await rm(root, { recursive: true, force: true })
})

const SKILL = '.claude/skills/changelog-style/SKILL.md'
const skillText = (body: string): string =>
  `---\nname: changelog-style\ndescription: How release notes read\n---\n${body}\n`

async function write(home: string, path: string, text: string): Promise<void> {
  await mkdir(join(home, path, '..'), { recursive: true })
  await writeFile(join(home, path), text)
}

it('shows a picked part as the candidate holds it, even after its file changes', async () => {
  const bot = makeTestBot({ id: '3f2b6c1e-8d4a-4b7e-9c1f-5a6d7e8f9a0b', name: 'Release notes' })
  const home = join(root, 'home')
  await write(home, 'SOUL.md', '# Release notes\n')
  await write(home, SKILL, skillText('Name the customer, Acme.'))
  await write(home, 'memory/area-owners.md', 'Web: Dara\n')
  await write(home, 'memory/style.md', 'Past tense.\n')
  const candidates = new BotShareCandidates(join(root, 'candidates'))
  const summary = await candidates.prepare({
    bot,
    shareable: await readBotShareable({ bot, home, automations: [] }),
    selection: { memory: ['area-owners'] },
    packageId: 'package-1'
  })

  await write(home, SKILL, skillText('Say "a customer".'))
  await write(home, 'memory/area-owners.md', 'Web: Sam\n')
  await write(home, 'memory/style.md', 'Present tense.\n')
  const candidate = candidates.get(summary.candidateId)!
  const view = (part: string) => botSharePartFiles(candidate.shareable, part, candidate)

  expect((await view('skill:changelog-style'))[0]?.text).toBe(skillText('Name the customer, Acme.'))
  expect((await view('memory:area-owners'))[0]?.text).toBe('Web: Dara\n')
  // An unpicked note isn't in the candidate; its page shows the note as it is now.
  expect((await view('memory:style'))[0]?.text).toBe('Present tense.\n')
  await candidates.dispose()
})
