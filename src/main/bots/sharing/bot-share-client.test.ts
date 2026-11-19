import { expect, it } from 'vitest'
import { BotShareClient } from './bot-share-client'

it('keeps the bot name, publisher and publish date a link serves', async () => {
  const client = new BotShareClient({
    apiUrl: 'http://127.0.0.1:8787',
    auth: async (operation) => ({
      status: 'ok',
      value: await operation('token', 'http://127.0.0.1:8787')
    }),
    fetcher: async () =>
      new Response(
        JSON.stringify({
          share: {
            id: 'share-1',
            version: {
              packageId: 'package-1',
              versionId: 'version-1',
              name: 'bot-1',
              description: 'Drafts release notes.',
              packageDigest: 'a'.repeat(64),
              archiveSha256: 'b'.repeat(64),
              compressedBytes: 512,
              createdAt: '2026-11-08T00:00:00.000Z',
              releaseNotes: '',
              manifest: { displayName: 'Release notes' },
              publisher: { displayName: 'Dara' },
              publishedAt: '2026-11-08T16:12:00.000Z'
            }
          }
        }),
        { status: 200 }
      )
  })
  expect(await client.resolveShare('share-1')).toMatchObject({
    manifest: { displayName: 'Release notes' },
    publisher: { displayName: 'Dara' },
    publishedAt: '2026-11-08T16:12:00.000Z'
  })
})

function clientAnswering(status: number, body: unknown): BotShareClient {
  return new BotShareClient({
    apiUrl: 'http://127.0.0.1:8787',
    auth: async (operation) => ({
      status: 'ok',
      value: await operation('token', 'http://127.0.0.1:8787')
    }),
    fetcher: async () => new Response(JSON.stringify(body), { status })
  })
}

it('names a cloud with bot sharing off instead of failing generically', async () => {
  // What a cloud without the bot routes registered answers (production, flag off).
  const client = clientAnswering(404, {
    message: 'Route GET:/v1/bot-shares not found',
    error: 'Not Found',
    statusCode: 404
  })
  await expect(client.listShares()).rejects.toThrow('bot_share_unavailable')
})

it('still reads a named 404 as no package', async () => {
  const client = clientAnswering(404, { code: 'skill_package_not_found' })
  expect(await client.findPackageId('bot-1')).toEqual({ status: 'ok', value: null })
})
