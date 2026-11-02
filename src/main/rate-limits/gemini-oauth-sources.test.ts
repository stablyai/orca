import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => state.home
}))

const CREDS = { access_token: 'access', refresh_token: 'refresh', expiry_date: 1 }

describe.skipIf(process.platform === 'win32')('saveGeminiCredentials', () => {
  let previousUmask = 0

  beforeAll(() => {
    previousUmask = process.umask(0o022)
    state.home = mkdtempSync(join(tmpdir(), 'gemini-oauth-sources-'))
  })

  afterAll(() => {
    process.umask(previousUmask)
    rmSync(state.home, { recursive: true, force: true })
  })

  // #31125: orcad inherits login umask; replacement credentials must still be created owner-only.
  it('keeps the refreshed OAuth tokens owner-only under a permissive umask', async () => {
    // Import after mocking home because credential paths resolve at module load.
    const { saveGeminiCredentials } = await import('./gemini-oauth-sources')
    const path = join(state.home, '.gemini', 'oauth_creds.json')
    mkdirSync(join(state.home, '.gemini'))
    writeFileSync(path, '{}')
    chmodSync(path, 0o600)

    await saveGeminiCredentials(CREDS)

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(CREDS)
  })
})
