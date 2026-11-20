import { mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectorAvatarCache } from './connector-avatar-cache'
import { handleConnectorAvatarRequest } from './connector-avatar-protocol'
import { connectorAvatarSrc } from '../../shared/connector-avatar-scheme'

vi.mock('electron', () => ({ protocol: { handle: vi.fn() } }))

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const png = (): Response => new Response(PNG, { headers: { 'content-type': 'image/png' } })
const URL_A = 'https://avatars.githubusercontent.com/u/7?v=4'
const DAY = 24 * 60 * 60_000
const NOW = Date.UTC(2026, 0, 1)

let directory: string
afterEach(() => rmSync(directory, { recursive: true, force: true }))

function cache(fetch: (url: string) => Promise<Response>, now = () => NOW) {
  directory = mkdtempSync(join(tmpdir(), 'orca-connector-avatars-'))
  const calls = vi.fn(fetch)
  return {
    calls,
    avatars: new ConnectorAvatarCache({ directory: () => directory, fetch: calls, now })
  }
}

describe('ConnectorAvatarCache', () => {
  it('refuses a body that is not an image, whatever its content type says', async () => {
    const { avatars } = cache(
      async () =>
        new Response('<svg onload=alert(1)>', { headers: { 'content-type': 'image/png' } })
    )
    expect(await avatars.read(URL_A)).toBeNull()
  })

  it('follows a redirect only to another avatar host', async () => {
    const { avatars } = cache(async (url) =>
      url === URL_A
        ? new Response(null, {
            status: 302,
            headers: { location: 'https://avatars.githubusercontent.com/u/7?v=5' }
          })
        : png()
    )
    expect(await avatars.read(URL_A)).toMatchObject({ mimeType: 'image/png' })
    // Gravatar's miss goes through an image proxy that would fetch any URL.
    for (const location of [
      'https://i1.wp.com/a.slack-edge.com/d.png',
      'http://169.254.169.254/x'
    ]) {
      const away = cache(async () => new Response(null, { status: 302, headers: { location } }))
      expect(await away.avatars.read(URL_A)).toBeNull()
      expect(away.calls).toHaveBeenCalledTimes(1)
    }
  })

  it('reuses a fresh disk copy and later serves it when refresh fails', async () => {
    let now = NOW
    let online = true
    const { avatars, calls } = cache(
      async () => {
        if (!online) {
          throw new Error('offline')
        }
        return png()
      },
      () => now
    )
    expect(await avatars.read(URL_A)).toEqual({ data: PNG, mimeType: 'image/png' })
    expect(await avatars.read(URL_A)).toEqual({ data: PNG, mimeType: 'image/png' })
    expect(calls).toHaveBeenCalledTimes(1)
    for (const name of readdirSync(directory)) {
      utimesSync(join(directory, name), new Date(now - 8 * DAY), new Date(now - 8 * DAY))
    }
    online = false
    now += DAY
    expect(await avatars.read(URL_A)).toEqual({ data: PNG, mimeType: 'image/png' })
    expect(calls).toHaveBeenCalledTimes(2)
  })
})

describe('handleConnectorAvatarRequest', () => {
  it('serves a cached avatar for an allowed url and nothing for any other', async () => {
    const read = vi.fn(async () => ({ data: PNG, mimeType: 'image/png' }))
    const ok = await handleConnectorAvatarRequest(new Request(connectorAvatarSrc(URL_A)), { read })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('image/png')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    const other = connectorAvatarSrc('https://example.com/a.png')
    expect((await handleConnectorAvatarRequest(new Request(other), { read })).status).toBe(404)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
