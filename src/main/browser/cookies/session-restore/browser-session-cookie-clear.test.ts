import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Cookie, CookiesSetDetails, Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import { setSecretStore } from '../../../../shared/secure-storage/secret-store'
import type { CdpCookie } from '../browser-cdp-cookie'
import type * as ClearStore from '../browser-cookie-clear-store'
import type * as Trackers from './browser-session-cookie-tracker'

type Listener = (event: unknown, cookie: Cookie, cause: string, removed: boolean) => void

const sessions = new Map<string, ReturnType<typeof fakeSession>>()
const io = vi.hoisted(() => ({ rmCalls: 0, rmFailures: 0, cdpReads: 0 }))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  session: { fromPartition: (partition: string) => sessions.get(partition) }
}))

vi.mock('../../sessions/profiles/browser-session-registry', () => ({ browserSessionRegistry: {} }))

// The snapshot file's removal, which a test can make fail as a busy or locked file does.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      io.rmCalls += 1
      if (io.rmFailures > 0) {
        io.rmFailures -= 1
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return actual.rm(...args)
    }
  }
})

// Stands in for the hidden CDP target: Network.getAllCookies reports what the jar holds.
vi.mock('../browser-cookie-clear-store', async (importOriginal) => ({
  ...(await importOriginal<typeof ClearStore>()),
  openCookieClearStore: (target: { cookies: { get: () => Promise<Cookie[]> } }) => ({
    readAllCdpCookies: async (): Promise<CdpCookie[]> => {
      io.cdpReads += 1
      return (await target.cookies.get()).map(
        ({ name, value, domain, path, secure, httpOnly }) => ({
          name,
          value,
          domain,
          path,
          secure,
          httpOnly,
          session: true
        })
      )
    },
    dispose: () => {}
  })
}))

function fakeSession() {
  let jar: Cookie[] = []
  // Set while a test holds the jar's reads, as a slow cookie store would.
  let held: Promise<void> | null = null
  const listeners = new Set<Listener>()
  // Chromium reports cookie changes on their own channel, after the call that made them.
  const emitLater = (cookie: Cookie, removed: boolean) =>
    setImmediate(() => listeners.forEach((listener) => listener({}, cookie, 'explicit', removed)))
  return {
    names: () => jar.map((cookie) => cookie.name).sort(),
    holdReads: () => {
      let release = () => {}
      held = new Promise((resolve) => (release = resolve))
      return () => {
        held = null
        release()
      }
    },
    cookies: {
      get: async () => {
        await held
        return jar.map((cookie) => ({ ...cookie }))
      },
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
  return {
    name,
    value: `${name}-value`,
    domain,
    path: '/',
    secure: true,
    httpOnly: false,
    session: true
  }
}

const PARTITION = 'persist:browser-profile-default'
let directory: string
// Set while a launch reads its file: the read fails as it does when the OS keychain refuses.
let decryptFails = false
let sealing = true

const snapshotFile = () => join(directory, 'browser-session-cookies', 'default.json')
const settle = () => new Promise((resolve) => setImmediate(resolve))

async function clearGoogle(): Promise<string> {
  const google = await import('../browser-google-cookie-clear')
  return google.clearGoogleCookiesFromPartition(PARTITION)
}

let lastTrackers: typeof Trackers | null = null

/** Waits for the snapshot writes queued now (a fired save's file I/O isn't a timer or microtask). */
async function writesDone(): Promise<void> {
  await Promise.all([...(lastTrackers?.sessionCookieTrackers.values() ?? [])].map((t) => t.saving))
}

async function elapse(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await writesDone()
}

async function launch(options: { clearWhileRestoring?: boolean; unreadable?: boolean } = {}) {
  // The previous launch dies here: its late cookie events and timers must not reach this one.
  for (const filePath of lastTrackers?.sessionCookieTrackers.keys() ?? []) {
    lastTrackers?.stopTrackingSessionCookies(filePath)
  }
  vi.resetModules()
  lastTrackers = await import('./browser-session-cookie-tracker')
  const jar = fakeSession()
  sessions.set(PARTITION, jar)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every Session member this code path calls.
  const target = jar as unknown as Session
  const snapshots = await import('./browser-session-cookie-snapshot-file')
  snapshots.configureBrowserSessionCookieSnapshots(directory)
  const restore = await import('./browser-session-cookie-restore')
  const clear = await import('./browser-session-cookie-clear')
  decryptFails = options.unreadable ?? false
  const restored = restore.restoreBrowserSessionCookies([
    { id: 'default', scope: 'default', partition: PARTITION, label: 'Default', source: null }
  ])
  try {
    await Promise.all([
      restored,
      options.clearWhileRestoring && clear.clearBrowserCookieJar(target)
    ])
  } finally {
    decryptFails = false
  }
  return { jar, target, clear, restore, snapshots }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-session-cookie-restore-'))
  decryptFails = false
  sealing = true
  Object.assign(io, { rmCalls: 0, rmFailures: 0, cdpReads: 0 })
  setSecretStore({
    isEncryptionAvailable: () => sealing,
    encryptString: (text) => Buffer.from(text, 'utf8'),
    decryptString: (cipher) => {
      if (decryptFails) {
        throw new Error('keychain refused')
      }
      return cipher.toString('utf8')
    },
    describeProtectionGap: () => null
  })
})

afterEach(() => {
  for (const filePath of lastTrackers?.sessionCookieTrackers.keys() ?? []) {
    lastTrackers?.stopTrackingSessionCookies(filePath)
  }
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

async function saveSnapshot(cookies: CdpCookie[]): Promise<void> {
  const { snapshots } = await launch()
  await snapshots.writeSessionCookieSnapshot(snapshots.snapshotPath('default'), cookies)
}

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
})

describe('session cookie snapshot that a launch could not read', () => {
  async function savedButUnread() {
    await saveSnapshot([sessionCookie('sid', 'example.com'), sessionCookie('SID', 'google.com')])
    const unread = await launch({ unreadable: true })
    expect(unread.jar.names()).toEqual([])
    return { ...unread, before: readFileSync(snapshotFile()) }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('a Google-only clear reports it unverified and leaves the file, past the save and quit', async () => {
    const { restore, before } = await savedButUnread()

    // It can't take only Google's cookies out of a file it couldn't read.
    expect(await clearGoogle()).toBe('unverified')
    expect(readFileSync(snapshotFile())).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)
    await elapse(60_000)
    await restore.flushBrowserSessionCookiesOnQuit()

    expect(readFileSync(snapshotFile())).toEqual(before)
    expect(io.cdpReads).toBe(0)
    expect((await launch()).jar.names()).toEqual(['SID', 'sid'])
  })

  it('cookies set and removed this launch leave the file, past the save and quit', async () => {
    const { jar, restore, before } = await savedButUnread()

    await jar.cookies.set({ url: 'https://example.org/', name: 'new' })
    await settle()
    expect(vi.getTimerCount()).toBe(0)
    await elapse(60_000)
    expect(readFileSync(snapshotFile())).toEqual(before)
    await jar.cookies.remove('https://example.org/', 'new')
    await settle()
    await elapse(60_000)
    await restore.flushBrowserSessionCookiesOnQuit()

    expect(readFileSync(snapshotFile())).toEqual(before)
    expect(io.cdpReads).toBe(0)
    expect((await launch()).jar.names()).toEqual(['SID', 'sid'])
  })

  it('a full clear still removes the file', async () => {
    const { target, clear } = await savedButUnread()
    await clear.clearBrowserCookieJar(target)

    expect(existsSync(snapshotFile())).toBe(false)
    expect((await launch()).jar.names()).toEqual([])
  })

  it('a full clear whose removal failed is retried by the next save', async () => {
    const { target, clear } = await savedButUnread()
    io.rmFailures = 1
    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('EBUSY')
    expect(existsSync(snapshotFile())).toBe(true)

    await elapse(30_000)

    expect(existsSync(snapshotFile())).toBe(false)
    expect((await launch()).jar.names()).toEqual([])
  })

  it('a full clear whose removal failed gets one last try at quit', async () => {
    const { target, clear, restore } = await savedButUnread()
    io.rmFailures = 1
    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('EBUSY')

    // Quit before the 30 s retry.
    await restore.flushBrowserSessionCookiesOnQuit()

    expect(existsSync(snapshotFile())).toBe(false)
    expect((await launch()).jar.names()).toEqual([])
  })

  it('a removal that keeps failing is retried by one save and at quit, then left', async () => {
    const { jar, target, clear, restore } = await savedButUnread()
    io.rmFailures = Number.POSITIVE_INFINITY
    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('EBUSY')

    await elapse(30_000)
    expect(io.rmCalls).toBe(2)
    // Events that leave no new cookie don't arm the old retry again.
    await jar.cookies.set({ url: 'https://example.org/', name: 'brief' })
    await settle()
    await jar.cookies.remove('https://example.org/', 'brief')
    await settle()
    await elapse(5 * 60_000)
    expect(io.rmCalls).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
    await restore.flushBrowserSessionCookiesOnQuit()

    expect(io.rmCalls).toBe(3)
    expect(existsSync(snapshotFile())).toBe(true)
  })

  it('a full clear whose removal failed still removes the file when new cookies cannot be sealed', async () => {
    const { jar, target, clear } = await savedButUnread()
    io.rmFailures = 1
    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('EBUSY')
    sealing = false
    await jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()

    await elapse(30_000)

    expect(io.cdpReads).toBe(0)
    expect(existsSync(snapshotFile())).toBe(false)
  })

  it('changes while unread are not kept, and saving resumes after a full clear', async () => {
    const { jar, target, clear } = await savedButUnread()
    for (let i = 0; i < 50; i++) {
      await jar.cookies.set({ url: `https://site${i}.example/`, name: 'sid' })
      await jar.cookies.remove(`https://site${i}.example/`, 'sid')
    }
    await settle()
    expect(lastTrackers?.sessionCookieTrackers.get(snapshotFile())?.changedScopes.size).toBe(0)

    await jar.cookies.set({ url: 'https://example.org/', name: 'early', secure: true })
    await settle()
    await clear.clearBrowserCookieJar(target)
    await jar.cookies.set({ url: 'https://example.org/', name: 'after', secure: true })
    await settle()
    await elapse(30_000)

    expect((await launch()).jar.names()).toEqual(['after'])
  })

  it('cookies set while sealing is unavailable leave the file, past the save and quit', async () => {
    const { jar, restore, before } = await savedButUnread()
    sealing = false

    await jar.cookies.set({ url: 'https://example.org/', name: 'new' })
    await settle()
    expect(vi.getTimerCount()).toBe(0)
    await elapse(60_000)
    expect(io.cdpReads).toBe(0)
    await restore.flushBrowserSessionCookiesOnQuit()

    expect(readFileSync(snapshotFile())).toEqual(before)
    sealing = true
    expect((await launch()).jar.names()).toEqual(['SID', 'sid'])
  })
})

describe('session cookie snapshot that a launch read', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('a Google clear with nothing to remove reports it empty and leaves the file', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    await launch()
    const before = readFileSync(snapshotFile())

    expect(await clearGoogle()).toBe('empty')

    expect(readFileSync(snapshotFile())).toEqual(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a Google clear reports it cleared, and a relaunch keeps the other sites', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com'), sessionCookie('SID', 'google.com')])
    await launch()

    expect(await clearGoogle()).toBe('cleared')

    expect((await launch()).jar.names()).toEqual(['sid'])
  })

  it('a save after a new cookie writes what the live jar holds', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    const { jar } = await launch()

    await jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()
    await elapse(30_000)

    expect(io.cdpReads).toBe(1)
    expect((await launch()).jar.names()).toEqual(['new', 'sid'])
  })

  it('a save after a sign-out that empties the jar removes the file', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    const { jar } = await launch()

    await jar.cookies.remove('https://example.com/', 'sid')
    await settle()
    await elapse(30_000)

    expect(io.cdpReads).toBe(1)
    expect(existsSync(snapshotFile())).toBe(false)
  })

  it('a clear whose kept cookies cannot be sealed fails and leaves the file', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com'), sessionCookie('SID', 'google.com')])
    const { restore } = await launch()
    const before = readFileSync(snapshotFile())
    sealing = false

    await expect(clearGoogle()).rejects.toThrow('unsealable')
    expect(readFileSync(snapshotFile())).toEqual(before)
    await elapse(5 * 60_000)
    expect(vi.getTimerCount()).toBe(0)
    expect(io.cdpReads).toBe(0)
    await restore.flushBrowserSessionCookiesOnQuit()

    expect(readFileSync(snapshotFile())).toEqual(before)
    expect(io.rmCalls).toBe(0)
  })

  it('a save while sealing is unavailable leaves the file, past the save and quit', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    const { jar, restore } = await launch()
    const before = readFileSync(snapshotFile())
    sealing = false

    await jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()
    await elapse(60_000)
    expect(io.cdpReads).toBe(0)
    await restore.flushBrowserSessionCookiesOnQuit()

    expect(readFileSync(snapshotFile())).toEqual(before)
  })

  it('a file that is not JSON is replaced by the next save of live cookies', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    writeFileSync(snapshotFile(), '{"format":"orca-browser-session-cook')
    const { jar } = await launch()
    expect(jar.names()).toEqual([])

    await jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()
    await elapse(30_000)

    expect(io.cdpReads).toBe(1)
    expect((await launch()).jar.names()).toEqual(['new'])
  })
})

describe('session cookie snapshot of a retired profile', () => {
  async function signedIn() {
    await saveSnapshot([sessionCookie('sid', 'example.com'), sessionCookie('SID', 'google.com')])
    return launch()
  }
  const isGoogle = (cookie: CdpCookie) => cookie.domain === 'google.com'

  it('a clear after a retirement whose removal failed is not reported persisted', async () => {
    const { target, clear, restore } = await signedIn()
    io.rmFailures = 1
    restore.forgetBrowserSessionCookies('default')

    expect(await clear.persistBrowserCookieClear(target, isGoogle)).toBe(false)
    expect(existsSync(snapshotFile())).toBe(true)
  })

  it('a clear after a retirement that removed the file is reported persisted', async () => {
    const { target, clear, restore } = await signedIn()
    restore.forgetBrowserSessionCookies('default')

    expect(await clear.persistBrowserCookieClear(target, isGoogle)).toBe(true)
    expect(existsSync(snapshotFile())).toBe(false)
  })

  it('a quit save held while the profile is retired does not write the file back', async () => {
    const { jar, restore } = await signedIn()
    await jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()
    const release = jar.holdReads()
    const quit = restore.flushBrowserSessionCookiesOnQuit()
    await settle()
    restore.forgetBrowserSessionCookies('default')
    while (existsSync(snapshotFile())) {
      await settle()
    }

    release()
    await quit

    expect(existsSync(snapshotFile())).toBe(false)
  })
})

describe('CDP cookie reply for a saved read', () => {
  it('a reply without a cookies array fails instead of reading as an empty jar', async () => {
    const { requireCdpCookies } = await import('../browser-cdp-cookie')
    expect(() => requireCdpCookies({})).toThrow('cdp_cookies_reply_invalid')
    expect(() => requireCdpCookies({ cookies: null })).toThrow('cdp_cookies_reply_invalid')
    expect(requireCdpCookies({ cookies: [] })).toEqual([])
  })
})
