import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTestBot } from '../bot.test-fixture'
import { useBotToolCredentialsRoot } from '../bot-tool-credentials'
import { BotShareCandidates } from './bot-package-export'
import { readBotPackageArchive } from './bot-package-archive'
import { BotShareClient } from './bot-share-client'
import { BOT_SHARE_ERRORS } from '../../../shared/bots/bot-share-errors'
import { BotShareService } from './bot-share-service'
import { readBotShareable } from './bot-share-sources'
import { BotSharePicksStore } from './bot-share-picks-store'
import { botShareStatusOf } from '../../../shared/bots/bot-share-status'

const API = 'http://127.0.0.1:8787'
const UPLOAD_URL = 'https://uploads.example.com/bucket'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-bot-share-test-'))
  useBotToolCredentialsRoot(join(root, 'credentials'))
})

afterEach(async () => {
  useBotToolCredentialsRoot(null)
  await rm(root, { recursive: true, force: true })
})

type Share = { id: string; packageId: string; name: string; pinnedVersionId: string; live: boolean }

/** Orca Cloud's bot routes, kept in memory: packages by name, versions, and canonical links. */
function fakeCloud() {
  const packages = new Map<
    string,
    { id: string; name: string; versions: Record<string, unknown>[] }
  >()
  const shares: Share[] = []
  let uploaded: Buffer | null = null
  let counter = 0
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  const fetcher = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    if (url.origin === new URL(UPLOAD_URL).origin) {
      const upload = init?.body
      if (!(upload instanceof Readable)) {
        throw new Error('expected a streamed upload')
      }
      const chunks: Buffer[] = []
      for await (const chunk of upload) {
        chunks.push(Buffer.from(chunk))
      }
      const bytes = Buffer.concat(chunks)
      const start = bytes.indexOf('\r\n\r\n', bytes.indexOf('filename="package.tar.gz"')) + 4
      uploaded = bytes.subarray(start, bytes.lastIndexOf('\r\n--'))
      return new Response(null, { status: 204 })
    }
    const path = url.pathname
    const byName = /^\/v1\/bot-packages\/by-name\/(.+)$/.exec(path)
    if (byName) {
      const found = [...packages.values()].find((entry) => entry.name === byName[1])
      return found
        ? json(200, { package: { id: found.id } })
        : json(404, { code: 'skill_package_not_found' })
    }
    if (path === '/v1/skill-packages/uploads' && method === 'POST') {
      return json(201, {
        upload: { id: `upload-${++counter}`, policy: { url: UPLOAD_URL, fields: { key: 'k' } } }
      })
    }
    if (/^\/v1\/skill-packages\/uploads\/[^/]+\/finalize$/.test(path)) {
      const archivePath = join(root, `uploaded-${++counter}.tar.gz`)
      await writeFile(archivePath, uploaded ?? Buffer.alloc(0))
      const read = await readBotPackageArchive({
        archivePath,
        destinationDirectory: join(root, `uploaded-${counter}`)
      })
      const entry = packages.get(read.transport.packageId) ?? {
        id: read.transport.packageId,
        name: read.transport.name,
        versions: []
      }
      packages.set(entry.id, entry)
      const version = {
        packageId: entry.id,
        versionId: read.transport.versionId,
        name: read.transport.name,
        description: read.transport.description,
        packageDigest: read.transport.botDigest,
        archiveSha256: read.archiveSha256,
        compressedBytes: read.compressedBytes,
        createdAt: '2026-11-08T00:00:00.000Z',
        manifest: read.transport
      }
      entry.versions.push(version)
      return json(200, { version })
    }
    const canonical = /^\/v1\/bot-packages\/([^/]+)\/shares$/.exec(path)
    if (canonical && method === 'POST') {
      const entry = packages.get(canonical[1])!
      const live = shares.find((share) => share.packageId === entry.id && share.live)
      const share = live ?? {
        id: `share-${shares.length + 1}`,
        packageId: entry.id,
        name: entry.name,
        pinnedVersionId: body.pinnedVersionId,
        live: true
      }
      if (!live) {
        shares.push(share)
      }
      share.pinnedVersionId = body.pinnedVersionId
      const status = live ? 200 : 201
      return json(status, {
        share: {
          id: share.id,
          url: `https://app.onorca.dev/bots/share/${share.id}`,
          pinnedVersionId: share.pinnedVersionId,
          canonical: true,
          created: !live
        }
      })
    }
    const one = /^\/v1\/bot-shares\/([^/]+)$/.exec(path)
    const share = one ? shares.find((entry) => entry.id === one[1] && entry.live) : undefined
    if (one && method === 'GET') {
      const asked = url.searchParams.get('versionId') ?? share?.pinnedVersionId
      const version = [...packages.values()]
        .flatMap((entry) => entry.versions)
        .find((entry) => entry.versionId === asked)
      if (!share || !version) {
        return json(404, { code: 'skill_share_not_found' })
      }
      return json(200, {
        share: {
          version: {
            ...version,
            publisher: { displayName: null },
            publishedAt: '2026-11-09T15:12:00.000Z'
          }
        }
      })
    }
    if (one && method === 'DELETE') {
      if (!share) {
        return json(404, { code: 'skill_share_not_found' })
      }
      share.live = false
      return new Response(null, { status: 204 })
    }
    if (one && method === 'PATCH') {
      if (!share) {
        return json(404, { code: 'skill_share_not_found' })
      }
      if (share.pinnedVersionId !== body.expectedVersionId) {
        return json(409, { code: 'share_version_changed', currentVersionId: share.pinnedVersionId })
      }
      share.pinnedVersionId = body.pinnedVersionId
      return json(200, {
        share: {
          id: share.id,
          url: `https://app.onorca.dev/bots/share/${share.id}`,
          pinnedVersionId: share.pinnedVersionId,
          repointed: true
        }
      })
    }
    if (path === '/v1/bot-shares' && method === 'GET') {
      return json(200, {
        shares: shares
          .filter((entry) => entry.live)
          .map((entry) => ({
            id: entry.id,
            url: `https://app.onorca.dev/bots/share/${entry.id}`,
            packageId: entry.packageId,
            name: entry.name,
            createdAt: '2026-11-08T00:00:00.000Z',
            pinnedVersionId: entry.pinnedVersionId,
            canonical: true
          }))
      })
    }
    return json(404, { code: 'not_found' })
  }
  const typed: typeof fetch = fetcher
  return { fetcher: typed, shares }
}

const bot = makeTestBot({ id: '3f2b6c1e-8d4a-4b7e-9c1f-5a6d7e8f9a0b', name: 'Release notes' })

async function writeHome(home: string, soul: string): Promise<void> {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'SOUL.md'), soul)
}

/** One run of the app: its own candidates folder, the same cloud. */
function appSession(
  cloud: ReturnType<typeof fakeCloud>,
  home: string,
  name: string,
  account = { signedIn: true },
  picks?: BotSharePicksStore
) {
  return new BotShareService({
    client: new BotShareClient({
      fetcher: cloud.fetcher,
      auth: async (operation) =>
        account.signedIn
          ? { status: 'ok', value: await operation('token', API) }
          : { status: 'reconnect-required' }
    }),
    candidates: new BotShareCandidates(join(root, name)),
    readShareable: (entry) => readBotShareable({ bot: entry, home, automations: [] }),
    picks
  })
}

async function publish(service: BotShareService) {
  const { candidate } = await service.prepare(bot, {})
  const published = await service.publish(bot, candidate.candidateId, '')
  if (published.status !== 'ok') {
    throw new Error(published.status)
  }
  return published.value
}

describe('sharing a bot by link', () => {
  it('keeps one link across publishes and an app restart', async () => {
    const cloud = fakeCloud()
    const home = join(root, 'home')
    await writeHome(home, '# Release notes\n\nDrafts release notes.\n')
    const first = await publish(appSession(cloud, home, 'run-1'))

    await writeHome(home, '# Release notes\n\nDrafts release notes, now weekly.\n')
    const restarted = appSession(cloud, home, 'run-2')
    const second = await publish(restarted)

    expect(first.share).toMatchObject({ id: 'share-1', created: true })
    expect(second.share).toMatchObject({ id: 'share-1', created: false })
    expect(second.version.packageId).toBe(first.version.packageId)
    expect(second.share.pinnedVersionId).toBe(second.version.versionId)
    expect(second.version.versionId).not.toBe(first.version.versionId)
    expect(await restarted.status(bot)).toEqual({
      status: 'ok',
      value: {
        shared: true,
        shareId: 'share-1',
        url: 'https://app.onorca.dev/bots/share/share-1',
        versionId: second.version.versionId,
        createdAt: '2026-11-08T00:00:00.000Z',
        updatedAt: '2026-11-08T00:00:00.000Z',
        digest: null,
        olderLinks: 0
      }
    })
  })

  it('never makes a new link when Update link finds the link stopped', async () => {
    const cloud = fakeCloud()
    const home = join(root, 'home')
    await writeHome(home, '# Release notes\n\nDrafts release notes.\n')
    const service = appSession(cloud, home, 'run-1')
    const first = await publish(service)
    expect(await service.stop(first.share.id)).toEqual({ status: 'ok', value: true })

    const { candidate } = await service.prepare(bot, {})
    await expect(
      service.update(bot, candidate.candidateId, '', {
        shareId: first.share.id,
        expectedVersionId: first.version.versionId
      })
    ).rejects.toThrow(BOT_SHARE_ERRORS.stopped)
    expect(cloud.shares.filter((share) => share.live)).toEqual([])
    expect(await service.status(bot)).toEqual({ status: 'ok', value: { shared: false } })
  })

  it('publishes the reviewed candidate once a refused note is fixed', async () => {
    const cloud = fakeCloud()
    const home = join(root, 'home')
    await writeHome(home, '# Release notes\n\nDrafts release notes.\n')
    const service = appSession(cloud, home, 'run-1')
    const { candidate } = await service.prepare(bot, {})

    await expect(
      service.publish(bot, candidate.candidateId, 'Post with xoxb-1234567890-abcdef.')
    ).rejects.toThrow(BOT_SHARE_ERRORS.noteSecret)
    expect(cloud.shares).toEqual([])

    const published = await service.publish(bot, candidate.candidateId, 'Connect Slack first.')
    expect(published).toMatchObject({ status: 'ok', value: { share: { id: 'share-1' } } })
  })

  it('publishes on a retry after a signed-out attempt', async () => {
    const cloud = fakeCloud()
    const home = join(root, 'home')
    await writeHome(home, '# Release notes\n\nDrafts release notes.\n')
    const account = { signedIn: false }
    const service = appSession(cloud, home, 'run-1', account)
    const { candidate } = await service.prepare(bot, {})

    expect(await service.publish(bot, candidate.candidateId, 'Connect Slack first.')).toEqual({
      status: 'reconnect-required'
    })
    account.signedIn = true
    const published = await service.publish(bot, candidate.candidateId, 'Connect Slack first.')
    expect(published).toMatchObject({ status: 'ok', value: { share: { id: 'share-1' } } })
  })

  it('reopens Update link on the picks and note the link serves, reading as up to date', async () => {
    const cloud = fakeCloud()
    const home = join(root, 'home')
    await writeHome(home, '# Release notes\n\nDrafts release notes.\n')
    await mkdir(join(home, 'memory'), { recursive: true })
    await writeFile(join(home, 'memory', 'area-owners.md'), '# Area owners\n\nWeb: Ana.\n')
    const picks = new BotSharePicksStore(join(root, 'bot-share-picks.json'))
    const service = appSession(cloud, home, 'run-1', { signedIn: true }, picks)
    const { candidate } = await service.prepare(bot, { memory: ['area-owners'] })
    const published = await service.publish(bot, candidate.candidateId, 'Connect Slack first.')
    if (published.status !== 'ok') {
      throw new Error(published.status)
    }

    const reopened = appSession(cloud, home, 'run-2', { signedIn: true }, picks)
    const again = await reopened.prepare(bot, {}, { last: true })
    const listed = await reopened.list([bot], bot.id)
    if (listed.status !== 'ok') {
      throw new Error(listed.status)
    }

    expect(again.last).toEqual({
      selection: { memory: ['area-owners'] },
      setupNote: 'Connect Slack first.'
    })
    expect(again.candidate.bot.memory).toEqual([{ topic: 'area-owners' }])
    expect(botShareStatusOf(listed.value, bot.id)).toMatchObject({
      updatedAt: '2026-11-09T15:12:00.000Z',
      digest: again.candidate.botDigest
    })
    expect(published.value.version.packageDigest).toBe(again.candidate.botDigest)
  })

  it('forgets the last published picks when the link is stopped or the bot deleted', async () => {
    const cloud = fakeCloud()
    const home = join(root, 'home')
    await writeHome(home, '# Release notes\n\nDrafts release notes.\n')
    await mkdir(join(home, 'memory'), { recursive: true })
    await writeFile(join(home, 'memory', 'area-owners.md'), '# Area owners\n\nWeb: Ana.\n')
    const picks = new BotSharePicksStore(join(root, 'bot-share-picks.json'))
    const service = appSession(cloud, home, 'run-1', { signedIn: true }, picks)
    const { candidate } = await service.prepare(bot, { memory: ['area-owners'] })
    const published = await service.publish(bot, candidate.candidateId, '')
    if (published.status !== 'ok') {
      throw new Error(published.status)
    }
    await picks.set('other-bot', { selection: { memory: ['x'] }, setupNote: '' })

    await service.stop(published.value.share.id, bot.id)
    await picks.forget('other-bot')

    expect((await service.prepare(bot, {}, { last: true })).last).toBeUndefined()
    expect(await picks.get('other-bot')).toBeNull()
  })

  it("reads the pinned version only for the asked bot's link, on any computer", async () => {
    const cloud = fakeCloud()
    const home = join(root, 'home')
    await writeHome(home, '# Release notes\n\nDrafts release notes.\n')
    const service = appSession(cloud, home, 'run-1')
    const published = await publish(service)

    const unasked = await service.list([bot])
    const onServer = await service.list([], bot.id)
    if (unasked.status !== 'ok' || onServer.status !== 'ok') {
      throw new Error('unlisted')
    }

    expect(botShareStatusOf(unasked.value, bot.id)).toMatchObject({ digest: null })
    expect(botShareStatusOf(onServer.value, bot.id)).toMatchObject({
      updatedAt: '2026-11-09T15:12:00.000Z',
      digest: published.version.packageDigest
    })
  })
})
