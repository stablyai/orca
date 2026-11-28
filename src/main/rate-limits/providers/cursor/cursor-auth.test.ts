import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, randomBytes } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { readCursorDesktopProfile } from '../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn'
import { readCursorAuthSession } from './cursor-auth'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../../../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readCursorDesktopProfile: vi.fn(async () => ({ status: 'missing' }))
}))

// Payload {"sub":"auth0|user_1"}; no exp, so it never expires.
const jwt = 'e30.eyJzdWIiOiJhdXRoMHx1c2VyXzEifQ.sig'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cursor-auth-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  vi.mocked(runProcess).mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('reads the cursor-agent token from auth.dpapi when auth.json points to the Windows secret store', async () => {
  // cursor-agent 2026.11.22 writes {version:1,dpapi} next to auth.json and leaves only the marker there.
  const blob = 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA'
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ storedIn: 'os-secret-store' }))
  writeFileSync(join(dir, 'auth.dpapi'), JSON.stringify({ version: 1, dpapi: blob }))
  const plaintext = JSON.stringify({ accessToken: jwt, refreshToken: 'r' })
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: `${Buffer.from(plaintext).toString('base64')}\r\n`,
    stderr: '',
    timedOut: false
  })

  const result = await readCursorAuthSession({
    cliAuthPath: join(dir, 'auth.json'),
    cliConfigPath: join(dir, 'cli-config.json'),
    desktopStateDbPath: join(dir, 'state.vscdb')
  })

  expect(result).toMatchObject({
    status: 'ok',
    session: { source: 'cli', token: { raw: jwt, subject: 'auth0|user_1' } }
  })
  // The encrypted credential travels over stdin, never argv.
  const spec = vi.mocked(runProcess).mock.calls[0]?.[0]
  expect(spec?.input).toBe(blob)
  expect(spec?.args?.join(' ')).not.toContain(blob)
})

// Cursor 3.x encrypts the IDE token at rest: `cursor-safe-storage:v1:` + v10 + AES-256-GCM under the
// DPAPI-wrapped os_crypt key in the profile's Local State.
function safeStorageEncrypt(token: string, key: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return `cursor-safe-storage:v1:${Buffer.concat([
    Buffer.from('v10'),
    nonce,
    ciphertext,
    cipher.getAuthTag()
  ]).toString('base64')}`
}

function ideProfile(accessToken: string) {
  vi.mocked(readCursorDesktopProfile).mockResolvedValue({
    status: 'ok',
    profile: {
      accessToken,
      email: 'ide@example.com',
      membershipType: 'ultra',
      subscriptionStatus: 'active'
    }
  })
}

function writeLocalState(root: string, wrappedKey: Buffer) {
  writeFileSync(
    join(root, 'Local State'),
    JSON.stringify({ os_crypt: { encrypted_key: wrappedKey.toString('base64') } })
  )
}

function desktopSessionOptions() {
  return {
    cliAuthPath: join(dir, 'auth.json'),
    cliConfigPath: join(dir, 'cli-config.json'),
    desktopStateDbPath: join(dir, 'User', 'globalStorage', 'state.vscdb')
  }
}

it('decrypts the Cursor IDE token encrypted at rest via the DPAPI-wrapped os_crypt key (#37785)', async () => {
  const key = randomBytes(32)
  const wrappedKey = Buffer.concat([Buffer.from('DPAPI'), randomBytes(29)])
  writeLocalState(dir, wrappedKey)
  ideProfile(safeStorageEncrypt(jwt, key))
  vi.mocked(runProcess).mockResolvedValue({
    code: 0,
    signal: null,
    stdout: `${key.toString('base64')}\r\n`,
    stderr: '',
    timedOut: false
  })

  expect(await readCursorAuthSession(desktopSessionOptions())).toMatchObject({
    status: 'ok',
    session: { source: 'desktop', token: { raw: jwt } }
  })
})

it('reports a failed encryption-key read instead of expired-login guidance', async () => {
  writeLocalState(dir, Buffer.concat([Buffer.from('DPAPI'), randomBytes(29)]))
  ideProfile(safeStorageEncrypt(jwt, randomBytes(32)))
  const expired = `e30.${Buffer.from(JSON.stringify({ sub: 'auth0|user_stale', exp: 1 })).toString(
    'base64url'
  )}.sig`
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ accessToken: expired }))
  vi.mocked(runProcess).mockRejectedValue(new Error('PowerShell DPAPI decryption did not finish'))

  expect(await readCursorAuthSession(desktopSessionOptions())).toEqual({
    status: 'error',
    error: 'Unable to read the Cursor IDE encryption key'
  })
})

it('reuses a cached Linux keyring error on normal reads but recovers on retryLinuxKeyringError after unlock', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  const authPath = join(dir, 'auth.json')
  writeFileSync(authPath, JSON.stringify({ storedIn: 'os-secret-store' }))
  const lockedOutput = '[/org/freedesktop/secrets/collection/login/1]\nlabel = cursor\n'
  const unlockedOutput = `[/org/freedesktop/secrets/collection/login/1]\nsecret = ${JSON.stringify({ accessToken: jwt })}\n`
  vi.mocked(runProcess)
    .mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: lockedOutput,
      stderr: '',
      timedOut: false
    })
    .mockResolvedValueOnce({
      code: 0,
      signal: null,
      stdout: unlockedOutput,
      stderr: '',
      timedOut: false
    })

  const options = {
    cliAuthPath: authPath,
    cliConfigPath: join(dir, 'cli-config.json'),
    desktopStateDbPath: join(dir, 'state.vscdb')
  }
  const first = await readCursorAuthSession(options)
  expect(first.status).toBe('error')

  // Background poll reuses the cached error without re-running secret-tool while auth.json mtime is unchanged.
  const second = await readCursorAuthSession(options)
  expect(second).toEqual(first)
  expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(1)

  // Explicit user refresh bypasses the settled error and caches the unlocked token for subsequent reads.
  const retried = await readCursorAuthSession({ ...options, retryLinuxKeyringError: true })
  expect(retried).toMatchObject({
    status: 'ok',
    session: { source: 'keychain', token: { raw: jwt } }
  })
  expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(2)

  // Subsequent normal read hits the newly cached ok token without calling secret-tool again.
  const afterUnlock = await readCursorAuthSession(options)
  expect(afterUnlock).toEqual(retried)
  expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(2)
})
