import { mkdtempSync, rmSync } from 'node:fs'
import type * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof os>()),
  homedir: () => home.dir
}))

const { saveGoogleAccount } = await import('./google-credential-store')
export const { googleApi } = await import('./google-api-client')

export const NOW = 1_800_000_000_000
export const EMAIL = 'reader@example.com'

beforeEach(async () => {
  home.dir = mkdtempSync(join(tmpdir(), 'google-api-http-'))
  await saveGoogleAccount({
    email: EMAIL,
    client: { clientId: 'id', clientSecret: 'secret' },
    refreshToken: 'refresh',
    accessToken: 'old-token',
    expiresAt: NOW + 3_600_000,
    grantedScopes: [],
    status: 'connected',
    services: [],
    connectedAt: NOW
  })
})

afterEach(() => rmSync(home.dir, { recursive: true, force: true }))
