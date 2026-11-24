import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BOT_SHARE_ERRORS } from '../../../shared/bots/bot-share-errors'
import { makeTestBot } from '../bot.test-fixture'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { BotShareCandidates } from './bot-package-export'
import { BotShareClient } from './bot-share-client'
import { BotShareService } from './bot-share-service'
import { readBotShareable } from './bot-share-sources'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bot-share-service-test-'))
  useBotToolCredentialsRoot(join(root, 'credentials'))
})

afterEach(async () => {
  useBotToolCredentialsRoot(null)
  await rm(root, { recursive: true, force: true })
})

// STA-16989: an older pick that finished late replaced the newer pick's preview, which then expired.
it("never lets an older build's preview replace the newer one's", async () => {
  const bot = makeTestBot({ id: '3f2b6c1e-8d4a-4b7e-9c1f-5a6d7e8f9a0b', name: 'Release notes' })
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'SOUL.md'), '# Release notes\n')
  const shareable = await readBotShareable({ bot, home, automations: [] })
  let finishOlder: () => void = () => {}
  const olderRead = new Promise<void>((resolve) => {
    finishOlder = resolve
  })
  let reads = 0
  const candidates = new BotShareCandidates(join(root, 'candidates'))
  const service = new BotShareService({
    // Local-only builds never ask the cloud for the package id.
    client: new BotShareClient({
      auth: async () => {
        throw new Error('not signed in')
      }
    }),
    candidates,
    readShareable: async () => {
      reads += 1
      if (reads === 1) {
        await olderRead
      }
      return shareable
    }
  })
  try {
    const older = service.prepare(bot, {}, { localOnly: true })
    const newer = await service.prepare(bot, {}, { localOnly: true })

    finishOlder()

    await expect(older).rejects.toThrow(BOT_SHARE_ERRORS.prepareAgain)
    expect(candidates.get(newer.candidate.candidateId)).not.toBeNull()
  } finally {
    await candidates.dispose()
  }
})
