import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CursorAuthReadResult } from '../rate-limits/cursor-auth'
import { ensureCursorSdkLoginFromSession } from './cursor-sdk-session-login'

const SESSION_TOKEN = 'existing-cursor-session-token'
const MINTED_KEY = 'crsr-minted-key'

function signedIn(): CursorAuthReadResult {
  return {
    status: 'ok',
    session: {
      email: 'dev@example.com',
      displayName: null,
      membershipType: null,
      subscriptionStatus: null,
      source: 'keychain',
      token: { raw: SESSION_TOKEN, subject: 'user_1', expiresAtMs: null }
    }
  }
}

describe('ensureCursorSdkLoginFromSession', () => {
  let directory: string

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  async function authPath(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), 'orca-cursor-sdk-login-'))
    return join(directory, 'sdk', 'auth.json')
  }

  it('keeps a stored SDK login and does not mint another key', async () => {
    const path = await authPath()
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(directory, 'sdk'), { recursive: true })
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        backendUrl: 'https://api2.cursor.sh',
        apiKey: 'already-stored',
        createdAtMs: 1,
        apiKeyExpiresAtMs: 5_000
      })
    )
    const fetchImpl = vi.fn()
    const readSession = vi.fn()

    await expect(
      ensureCursorSdkLoginFromSession({
        authPath: path,
        now: () => 1_000,
        fetchImpl,
        readSession
      })
    ).resolves.toBe(true)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(readSession).not.toHaveBeenCalled()
  })

  it('mints an SDK key from the Cursor session already on this machine', async () => {
    const path = await authPath()
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ apiKey: MINTED_KEY }), {
        status: 200
      })
    })

    await expect(
      ensureCursorSdkLoginFromSession({
        authPath: path,
        now: () => 1_000,
        backendUrl: 'https://api2.cursor.sh',
        readSession: async () => signedIn(),
        fetchImpl
      })
    ).resolves.toBe(true)

    const init = fetchImpl.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/CreateUserApiKey'
    )
    expect(headers.get('Authorization')).toBe(`Bearer ${SESSION_TOKEN}`)
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: 'Orca',
      expiresAt: String(1_000 + 7_776_000_000)
    })
    const stored: unknown = JSON.parse(await readFile(path, 'utf8'))
    expect(stored).toMatchObject({
      version: 1,
      backendUrl: 'https://api2.cursor.sh',
      apiKey: MINTED_KEY,
      email: 'dev@example.com',
      createdAtMs: 1_000
    })
    expect(JSON.stringify(stored)).not.toContain(SESSION_TOKEN)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
  })

  it('leaves the browser login in place when this machine has no Cursor session', async () => {
    const path = await authPath()
    const fetchImpl = vi.fn()
    await expect(
      ensureCursorSdkLoginFromSession({
        authPath: path,
        fetchImpl,
        readSession: async () => ({ status: 'missing' })
      })
    ).resolves.toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([
    [
      'the request fails',
      async () => {
        throw new Error('offline')
      }
    ],
    ['the reply is not JSON', async () => new Response('<html>', { status: 200 })]
  ])('leaves the browser login in place when %s', async (_name, reply) => {
    await expect(
      ensureCursorSdkLoginFromSession({
        authPath: await authPath(),
        readSession: async () => signedIn(),
        fetchImpl: vi.fn<typeof fetch>(reply)
      })
    ).resolves.toBe(false)
  })
})
