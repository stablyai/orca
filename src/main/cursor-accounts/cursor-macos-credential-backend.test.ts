import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { createCursorMacOSCredentialBackend } from './cursor-macos-credential-backend'
import { cursorSnapshot } from './cursor-account-test-fixtures'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))

/** In-memory stand-in for the three keychain items `security` manages. */
function fakeKeychain(items: Record<string, string>, failWriteOf?: string) {
  const ok = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
  vi.mocked(runProcess).mockImplementation(async (spec: ProcessSpec) => {
    const args = spec.args ?? []
    if (args[0] === 'find-generic-password') {
      const value = items[args[2]]
      return value === undefined ? { ...ok, code: 44 } : { ...ok, stdout: `${value}\n` }
    }
    if (args[0] === 'delete-generic-password') {
      const had = delete items[args[2]]
      return had ? ok : { ...ok, code: 44 }
    }
    const add = /add-generic-password -U -s "([^"]+)" -a "cursor-user" -w (\S+)\n/.exec(
      typeof spec.input === 'string' ? spec.input : ''
    )
    if (!add) {
      return { ...ok, code: 1 }
    }
    if (add[1] === failWriteOf) {
      return { ...ok, code: 1 }
    }
    items[add[1]] = add[2]
    return ok
  })
  return items
}

let dir: string
let configPath: string
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  dir = mkdtempSync(join(tmpdir(), 'orca-cursor-backend-'))
  configPath = join(dir, 'cli-config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ version: 1, approvalMode: 'ask', authInfo: { email: 'a@example.invalid' } })
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

function keychainFor(snapshot = cursorSnapshot('user_a', 1)) {
  return fakeKeychain({
    'cursor-access-token': snapshot.accessToken,
    ...(snapshot.refreshToken ? { 'cursor-refresh-token': snapshot.refreshToken } : {})
  })
}

describe('Cursor macOS credential backend', () => {
  it('reads the access token, refresh token and CLI identity as one sign-in', async () => {
    const snapshot = cursorSnapshot('user_a', 1)
    keychainFor(snapshot)

    const current = await createCursorMacOSCredentialBackend(configPath).read()

    expect(current).toMatchObject({ subject: 'user_a', email: 'a@example.invalid' })
    expect(current?.snapshot).toEqual({
      accessToken: snapshot.accessToken,
      refreshToken: snapshot.refreshToken,
      apiKey: null,
      authInfo: { email: 'a@example.invalid' }
    })
  })

  it('reports a signed-out CLI when the access token item is missing', async () => {
    fakeKeychain({})
    expect(await createCursorMacOSCredentialBackend(configPath).read()).toBeNull()
  })

  it('writes every item, drops an API key the new account lacks, and keeps other config', async () => {
    const items = fakeKeychain({
      'cursor-access-token': cursorSnapshot('user_a', 1).accessToken,
      'cursor-refresh-token': 'old-refresh',
      'cursor-api-key': 'old-key'
    })
    const next = cursorSnapshot('user_b', 1)

    await createCursorMacOSCredentialBackend(configPath).write(
      next,
      cursorSnapshot('user_a', 1).accessToken
    )

    expect(items).toEqual({
      'cursor-access-token': next.accessToken,
      'cursor-refresh-token': next.refreshToken
    })
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      version: 1,
      approvalMode: 'ask',
      authInfo: { email: 'user_b@example.invalid', displayName: 'Name user_b' }
    })
  })

  it('refuses to overwrite a sign-in that changed since it was read', async () => {
    const items = keychainFor()
    const before = { ...items }

    await expect(
      createCursorMacOSCredentialBackend(configPath).write(
        cursorSnapshot('user_b', 1),
        cursorSnapshot('user_c', 1).accessToken
      )
    ).rejects.toThrow('changed while switching')
    expect(items).toEqual(before)
  })

  it('restores the previous sign-in when a write fails part-way', async () => {
    const items = keychainFor()
    const before = { ...items }
    fakeKeychain(items, 'cursor-refresh-token')

    await expect(
      createCursorMacOSCredentialBackend(configPath).write(
        cursorSnapshot('user_b', 1),
        cursorSnapshot('user_a', 1).accessToken
      )
    ).rejects.toThrow('could not be accessed')
    expect(items['cursor-access-token']).toBe(before['cursor-access-token'])
    expect(JSON.parse(readFileSync(configPath, 'utf8')).authInfo).toEqual({
      email: 'a@example.invalid'
    })
  })

  it('refuses secrets that would need shell-style quoting', async () => {
    const items = keychainFor()
    const before = { ...items }

    await expect(
      createCursorMacOSCredentialBackend(configPath).write(
        cursorSnapshot('user_b', 1, { refreshToken: 'bad token"; delete' }),
        cursorSnapshot('user_a', 1).accessToken
      )
    ).rejects.toThrow('cannot store safely')
    expect(items).toEqual(before)
  })

  it('is unavailable off macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await expect(createCursorMacOSCredentialBackend(configPath).read()).rejects.toThrow(
      'unavailable on this host'
    )
  })
})
