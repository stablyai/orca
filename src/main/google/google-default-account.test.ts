import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const home = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (actual) => ({
  ...(await actual<typeof os>()),
  homedir: () => home.dir
}))

const {
  removeGoogleAccount,
  resolveGoogleDefaultAccount,
  saveGoogleAccount,
  saveGoogleDefaultAccount
} = await import('./google-credential-store')
const { resolveGoogleAccount } = await import('./google-api-client')

async function connect(email: string, connectedAt: number): Promise<void> {
  await saveGoogleAccount({
    email,
    client: { clientId: 'id', clientSecret: 'secret' },
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresAt: connectedAt + 3_600_000,
    grantedScopes: [],
    status: 'connected',
    services: [],
    connectedAt
  })
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), 'google-default-account-'))
})

afterEach(() => {
  rmSync(home.dir, { recursive: true, force: true })
})

describe('the Google account used without --account', () => {
  it('is none with no account, and the only account with one', async () => {
    expect(await resolveGoogleDefaultAccount()).toBeNull()
    await expect(resolveGoogleAccount(undefined)).rejects.toThrow('No Google account')
    await connect('work@acme.com', 1_000)
    expect(await resolveGoogleAccount(undefined)).toBe('work@acme.com')
  })

  it('takes the oldest on a host upgraded with several accounts and no default saved', async () => {
    await connect('new@gmail.com', 2_000)
    await connect('old@acme.com', 1_000)
    expect(await resolveGoogleAccount(undefined)).toBe('old@acme.com')
    // Kept once taken: the oldest signing in again (a newer connectedAt) doesn't move it.
    await connect('old@acme.com', 3_000)
    expect(await resolveGoogleAccount(undefined)).toBe('old@acme.com')
  })

  it('stays put when another account is added, and follows a pick', async () => {
    await connect('work@acme.com', 1_000)
    expect(await resolveGoogleDefaultAccount()).toBe('work@acme.com')
    await connect('me@gmail.com', 2_000)
    expect(await resolveGoogleAccount(undefined)).toBe('work@acme.com')
    expect(await saveGoogleDefaultAccount('ME@gmail.com')).toBe('me@gmail.com')
    expect(await resolveGoogleAccount(undefined)).toBe('me@gmail.com')
    expect(await resolveGoogleAccount('work@acme.com')).toBe('work@acme.com')
    await expect(saveGoogleDefaultAccount('gone@acme.com')).rejects.toThrow("isn't connected")
  })

  it('promotes the oldest account left when the default is removed', async () => {
    await connect('a@acme.com', 1_000)
    await connect('b@acme.com', 2_000)
    await connect('c@acme.com', 3_000)
    await saveGoogleDefaultAccount('b@acme.com')
    await removeGoogleAccount('b@acme.com')
    expect(await resolveGoogleAccount(undefined)).toBe('a@acme.com')
    await removeGoogleAccount('a@acme.com')
    expect(await resolveGoogleAccount(undefined)).toBe('c@acme.com')
    await removeGoogleAccount('c@acme.com')
    expect(await resolveGoogleDefaultAccount()).toBeNull()
  })

  it('never overwrites a saved default this host cannot read', async () => {
    await connect('a@acme.com', 1_000)
    await connect('b@acme.com', 2_000)
    // Bytes no secret store or plaintext read accepts, as when the Keychain is denied.
    const path = join(home.dir, '.orca', 'google', 'default-account.enc')
    const unreadable = Buffer.from([0xff, 0x00, 0xfe])
    writeFileSync(path, unreadable)
    expect(await resolveGoogleAccount(undefined)).toBe('a@acme.com')
    expect(readFileSync(path)).toEqual(unreadable)
  })
})
