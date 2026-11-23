import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Cookie, CookiesSetDetails, Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../../../shared/secure-storage/secret-store'
import type { CdpCookie } from '../browser-cdp-cookie'

type Listener = (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void

const sessions = new Map<string, ReturnType<typeof fakeSession>>()

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  session: { fromPartition: (partition: string) => sessions.get(partition) }
}))

function fakeSession() {
  let jar: Cookie[] = []
  const listeners = new Set<Listener>()
  // Chromium reports cookie changes on their own channel, after the call that made them.
  const emitLater = (cookie: Cookie, removed: boolean) =>
    setImmediate(() => listeners.forEach((listener) => listener({}, cookie, 'explicit', removed)))
  return {
    names: () => jar.map((cookie) => cookie.name).sort(),
    cookies: {
      get: async () => jar.map((cookie) => ({ ...cookie })),
      set: async (details: CookiesSetDetails) => {
        const cookie: Cookie = {
          name: details.name ?? '',
          value: details.value ?? '',
          domain: details.domain ?? new URL(details.url).hostname,
          hostOnly: !details.domain,
          path: details.path ?? '/',
          secure: details.secure ?? false,
          httpOnly: details.httpOnly ?? false,
          session: true,
          sameSite: details.sameSite ?? 'unspecified'
        }
        jar.push(cookie)
        emitLater(cookie, false)
      },
      remove: async (url: string, name: string) => {
        const host = new URL(url).hostname
        const removed = jar.filter(
          (cookie) => cookie.name === name && cookie.domain?.replace(/^\./, '') === host
        )
        jar = jar.filter((cookie) => !removed.includes(cookie))
        removed.forEach((cookie) => emitLater(cookie, true))
      },
      flushStore: async () => {},
      on: (_event: string, listener: Listener) => listeners.add(listener),
      off: (_event: string, listener: Listener) => listeners.delete(listener)
    },
    clearStorageData: async () => {
      const removed = jar
      jar = []
      removed.forEach((cookie) => emitLater(cookie, true))
    }
  }
}

function sessionCookie(name: string, domain: string): CdpCookie {
  return { name, value: `${name}-value`, domain, path: '/', secure: true, session: true }
}

const PARTITION = 'persist:browser-profile-default'
let directory: string

async function launch(options: { clearWhileRestoring?: boolean } = {}) {
  vi.resetModules()
  const jar = fakeSession()
  sessions.set(PARTITION, jar)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every Session member this code path calls.
  const target = jar as unknown as Session
  const snapshots = await import('./browser-session-cookie-snapshot-file')
  snapshots.configureBrowserSessionCookieSnapshots(directory)
  const restore = await import('./browser-session-cookie-restore')
  const clear = await import('./browser-session-cookie-clear')
  const restored = restore.restoreBrowserSessionCookies([
    { id: 'default', scope: 'default', partition: PARTITION, label: 'Default', source: null }
  ])
  await Promise.all([restored, options.clearWhileRestoring && clear.clearBrowserCookieJar(target)])
  return { jar, target, clear, snapshots }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-session-cookie-restore-'))
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text, 'utf8'),
    decryptString: (cipher) => cipher.toString('utf8'),
    describeProtectionGap: () => null
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('session cookie snapshot after a cookie clear', () => {
  async function signedIn() {
    const first = await launch()
    await first.snapshots.writeSessionCookieSnapshot(first.snapshots.snapshotPath('default'), [
      sessionCookie('sid', 'example.com'),
      sessionCookie('SID', 'google.com')
    ])
    const second = await launch()
    expect(second.jar.names()).toEqual(['SID', 'sid'])
    return second
  }

  it('a relaunch right after a full clear restores nothing', async () => {
    const { target, clear } = await signedIn()
    await clear.clearBrowserCookieJar(target)

    // Orca dies here, before the 30 s save.
    expect((await launch()).jar.names()).toEqual([])
  })

  it('a clear made while launch is still restoring is not undone by that restore', async () => {
    await signedIn()
    const cleared = await launch({ clearWhileRestoring: true })
    expect(cleared.jar.names()).toEqual([])

    expect((await launch()).jar.names()).toEqual([])
  })

  it('a relaunch right after a partial clear restores only what it kept', async () => {
    const { jar, target, clear } = await signedIn()
    await jar.cookies.remove('https://google.com/', 'SID')
    await clear.persistBrowserCookieClear(target, (cookie) => cookie.domain === 'google.com')

    expect((await launch()).jar.names()).toEqual(['sid'])
  })

  // chmod cannot hide a file from root or on Windows.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a clear that touches no saved cookie keeps a file this launch could not read',
    async () => {
      const first = await launch()
      const file = first.snapshots.snapshotPath('default')
      await first.snapshots.writeSessionCookieSnapshot(file, [sessionCookie('sid', 'example.com')])
      chmodSync(file, 0o000)
      const { target, clear, snapshots } = await launch()
      chmodSync(file, 0o600)

      await clear.persistBrowserCookieClear(target, (cookie) => cookie.domain === 'google.com')

      expect(
        (await snapshots.readSessionCookieSnapshot(file))?.map((cookie) => cookie.name)
      ).toEqual(['sid'])
    }
  )
})
