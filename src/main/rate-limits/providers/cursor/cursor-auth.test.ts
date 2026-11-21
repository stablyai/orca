import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

type AuthFileContents = { accessToken?: string; storedIn?: string; signedOut?: boolean }

function readWithAuthFile(contents: AuthFileContents) {
  writeFileSync(join(dir, 'auth.json'), JSON.stringify(contents))
  return readAgain()
}

function readAgain() {
  return readCursorAuthSession({
    cliAuthPath: join(dir, 'auth.json'),
    cliConfigPath: join(dir, 'cli-config.json'),
    desktopStateDbPath: join(dir, 'state.vscdb')
  })
}

// Fixed, increasing mtimes so each bump differs from the last without reading the clock.
const MTIME_BASE_MS = Date.UTC(2026, 0, 1)
let mtimeBumps = 0
function bumpAuthFileMtime() {
  mtimeBumps += 1
  const at = new Date(MTIME_BASE_MS + mtimeBumps * 60_000)
  utimesSync(join(dir, 'auth.json'), at, at)
}

const lockedItem = {
  code: 0,
  signal: null,
  stdout: '[/1]\nlabel = Cursor CLI credentials (cursor)\ncreated = 2026-11-19 10:00:00\n',
  stderr: 'secret-tool: Cannot get secret of a locked object\n',
  timedOut: false
}
const lockedError =
  "Orca couldn't read the Cursor login from your Linux keyring (locked or access not granted)."

function keyringItem(token: string) {
  return {
    code: 0,
    signal: null,
    stdout: `[/1]\nlabel = Cursor CLI credentials (cursor)\nsecret = {"accessToken":"${token}","refreshToken":"r"}\ncreated = 2026-11-19 10:00:00\n`,
    stderr: 'attribute.service = cursor-credentials\nattribute.account = cursor-user\n',
    timedOut: false
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cursor-auth-'))
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  vi.stubEnv('DBUS_SESSION_BUS_ADDRESS', 'unix:path=/run/user/1000/bus')
  vi.mocked(runProcess).mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('Cursor Linux keyring session', () => {
  it('reads the cursor-agent token from the Secret Service when auth.json points there', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce(keyringItem(jwt))

    const result = await readWithAuthFile({ storedIn: 'os-secret-store' })

    expect(result).toMatchObject({
      status: 'ok',
      session: { source: 'keychain', token: { raw: jwt, subject: 'auth0|user_1' } }
    })
    // `search` without --unlock does not ask the keyring to unlock during background refreshes.
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'secret-tool',
        args: ['search', 'service', 'cursor-credentials', 'account', 'cursor-user']
      })
    )
  })

  it('reads the keyring again only after cursor-agent rewrites auth.json', async () => {
    // Payload {"sub":"auth0|user_2"}.
    const nextJwt = 'e30.eyJzdWIiOiJhdXRoMHx1c2VyXzIifQ.sig'
    vi.mocked(runProcess)
      .mockResolvedValueOnce(keyringItem(jwt))
      .mockResolvedValueOnce(keyringItem(nextJwt))

    await readWithAuthFile({ storedIn: 'os-secret-store' })
    // Providers that confirm each secret read would prompt on every background refresh.
    expect(await readAgain()).toMatchObject({ session: { token: { raw: jwt } } })
    expect(runProcess).toHaveBeenCalledTimes(1)

    bumpAuthFileMtime()
    expect(await readAgain()).toMatchObject({ session: { token: { raw: nextJwt } } })
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('reuses a failed keyring read until cursor-agent rewrites auth.json', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce(lockedItem).mockResolvedValueOnce(keyringItem(jwt))

    expect(await readWithAuthFile({ storedIn: 'os-secret-store' })).toEqual({
      status: 'error',
      error: lockedError
    })
    // KeePassXC's unlock-before-search dialog must not reappear on each background refresh.
    expect(await readAgain()).toEqual({ status: 'error', error: lockedError })
    expect(runProcess).toHaveBeenCalledTimes(1)

    bumpAuthFileMtime()
    expect(await readAgain()).toMatchObject({ session: { token: { raw: jwt } } })
    expect(runProcess).toHaveBeenCalledTimes(2)
  })

  it('falls back to the Cursor IDE session when secret-tool fails', async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n',
      timedOut: false
    })
    vi.mocked(readCursorDesktopProfile).mockResolvedValueOnce({
      status: 'ok',
      profile: { accessToken: jwt, email: null, membershipType: null, subscriptionStatus: null }
    })

    const result = await readWithAuthFile({ storedIn: 'os-secret-store' })

    expect(result).toMatchObject({ status: 'ok', session: { source: 'desktop' } })
  })

  it('never runs secret-tool without the auth.json keyring marker', async () => {
    expect(await readWithAuthFile({ accessToken: jwt })).toMatchObject({
      session: { source: 'cli' }
    })
    expect(await readWithAuthFile({ signedOut: true })).toEqual({ status: 'missing' })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('shares one secret-tool run between concurrent cold reads', async () => {
    // Hold secret-tool open until both reads have started, so the second joins the first.
    let finishRead: () => void = () => {}
    vi.mocked(runProcess).mockImplementation(
      () => new Promise((resolve) => (finishRead = () => resolve(keyringItem(jwt))))
    )
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ storedIn: 'os-secret-store' }))

    const reads = Promise.all([readAgain(), readAgain()])
    await vi.waitFor(() => expect(runProcess).toHaveBeenCalled())
    finishRead()
    const [first, second] = await reads

    expect(first).toMatchObject({ session: { token: { raw: jwt } } })
    expect(second).toMatchObject({ session: { token: { raw: jwt } } })
    expect(runProcess).toHaveBeenCalledTimes(1)
  })

  it('does not reuse an in-flight read started for an older auth.json', async () => {
    // Payload {"sub":"auth0|user_2"}.
    const nextJwt = 'e30.eyJzdWIiOiJhdXRoMHx1c2VyXzIifQ.sig'
    let finishStaleRead: () => void = () => {}
    vi.mocked(runProcess)
      .mockImplementationOnce(
        () => new Promise((resolve) => (finishStaleRead = () => resolve(keyringItem(jwt))))
      )
      .mockResolvedValueOnce(keyringItem(nextJwt))
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ storedIn: 'os-secret-store' }))

    const stale = readAgain()
    await vi.waitFor(() => expect(runProcess).toHaveBeenCalledTimes(1))
    bumpAuthFileMtime()
    expect(await readAgain()).toMatchObject({ session: { token: { raw: nextJwt } } })
    finishStaleRead()
    await stale

    expect(await readAgain()).toMatchObject({ session: { token: { raw: nextJwt } } })
    expect(runProcess).toHaveBeenCalledTimes(2)
  })
})
