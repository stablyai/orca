import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BOT_SHARE_RECEIVE_ERRORS } from '../../../shared/bots/bot-share-received'
import { SKILL_PACKAGE_CONTENT_TYPE } from '../../../shared/skills/packages/skill-package-manifest'
import { BotShareCandidates } from './bot-package-export'
import { BotShareClient } from './bot-share-client'
import { sharedPackage } from './bot-share-received.test-fixture'
import { BotShareService } from './bot-share-service'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bot-share-reviewed-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One link on Orca Cloud serving the fixture package, which the test can move or stop. */
async function linkedCloud() {
  const fixture = await sharedPackage(root)
  const archive = await readFile(fixture.archivePath)
  const link = { pinned: fixture.version.versionId, live: true }
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin === 'https://dl.example.com') {
      return new Response(archive, { headers: { 'content-type': SKILL_PACKAGE_CONTENT_TYPE } })
    }
    if (!link.live) {
      return json(404, { code: 'skill_share_not_found' })
    }
    const asked = url.searchParams.get('versionId')
    if (asked && asked !== link.pinned) {
      return json(409, { code: 'share_version_changed' })
    }
    if (url.pathname === '/v1/bot-shares/share-1/download-grants' && init?.method === 'POST') {
      return json(200, {
        grant: { url: 'https://dl.example.com/a', expiresAt: '2099-01-01T00:00:00.000Z' },
        version: fixture.version
      })
    }
    return json(200, { share: { version: fixture.version } })
  }
  await mkdir(join(root, 'downloads'))
  const service = new BotShareService({
    client: new BotShareClient({
      apiUrl: 'http://127.0.0.1:8787',
      fetcher,
      auth: async () => ({ status: 'reconnect-required' })
    }),
    candidates: new BotShareCandidates(join(root, 'candidates')),
    readShareable: async () => {
      throw new Error('not sharing here')
    },
    download: {
      temporaryRoot: join(root, 'downloads'),
      allowedOrigins: ['https://dl.example.com'],
      requireHttps: true,
      fetcher
    }
  })
  return { service, link }
}

it('creates from the reviewed content only while the link serves the version reviewed', async () => {
  const { service, link } = await linkedCloud()
  const review = await service.review('share-1')
  if (!review) {
    throw new Error('no review')
  }

  // Create gets exactly the files the review showed.
  const reviewed = await service.reviewed(review.reviewId)
  expect(reviewed.files).toEqual(review.files.map(({ path, text }) => ({ path, text })))

  link.pinned = 'version-2'
  await expect(service.reviewed(review.reviewId)).rejects.toThrow(BOT_SHARE_RECEIVE_ERRORS.updated)
  link.live = false
  await expect(service.reviewed(review.reviewId)).rejects.toThrow(BOT_SHARE_RECEIVE_ERRORS.stopped)
  await expect(service.reviewed('00000000-0000-4000-8000-000000000000')).rejects.toThrow(
    BOT_SHARE_RECEIVE_ERRORS.expired
  )
})
