import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Cookie, Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as SecureFile from '../../../../shared/secure-storage/secure-file'
import { setSecretStore } from '../../../../shared/secure-storage/secret-store'
import type { CdpCookie } from '../browser-cdp-cookie'
import type * as ClearStore from '../browser-cookie-clear-store'
import type * as Trackers from './browser-session-cookie-tracker'
import { fakeSession, sessionCookie, type FakeIo } from './testing/fake-cookie-session.test-fixture'

const sessions = new Map<string, ReturnType<typeof fakeSession>>()
const io = vi.hoisted((): FakeIo => ({
  rmCalls: 0,
  rmFailures: 0,
  rmHold: null,
  writes: 0,
  cdpReads: 0,
  // When set, the CDP read replies with this, through the real reply check.
  cdpReply: undefined
}))

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
      const hold = io.rmHold
      if (hold) {
        await hold
      }
      if (io.rmFailures > 0) {
        io.rmFailures -= 1
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      return actual.rm(...args)
    }
  }
})

// Counts sealed writes, so a test can show one never landed, not just that a file went later.
vi.mock('../../../../shared/secure-storage/secure-file', async (importOriginal) => {
  const actual = await importOriginal<typeof SecureFile>()
  return {
    ...actual,
    writeSecureFile: (...args: Parameters<typeof actual.writeSecureFile>) => {
      io.writes += 1
      return actual.writeSecureFile(...args)
    }
  }
})

// Stands in for the hidden CDP target: Network.getAllCookies reports what the jar holds.
vi.mock('../browser-cookie-clear-store', async (importOriginal) => ({
  ...(await importOriginal<typeof ClearStore>()),
  openCookieClearStore: (target: { cookies: { get: () => Promise<Cookie[]> } }) => ({
    readAllCdpCookies: async (): Promise<CdpCookie[]> => {
      io.cdpReads += 1
      if (io.cdpReply !== undefined) {
        const { requireCdpCookies } = await import('../browser-cdp-cookie')
        return requireCdpCookies(io.cdpReply)
      }
      return (await target.cookies.get()).map(
        ({ name, value, domain, path, secure, httpOnly, session }) => ({
          name,
          value,
          domain,
          path,
          secure,
          httpOnly,
          session
        })
      )
    },
    dispose: () => {}
  })
}))

const PARTITION = 'persist:browser-profile-default'
let directory: string
// Set while a launch reads its file: the read fails as it does when the OS keychain refuses.
let decryptFails = false
// Names whose restore into the jar fails while a launch restores, as a rejected cookie does.
const rejectedSets = new Set<string>()
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

async function launch(
  options: { clearWhileRestoring?: boolean; unreadable?: boolean; unrestorable?: string[] } = {}
) {
  // The previous launch dies here: its late cookie events and timers must not reach this one.
  for (const filePath of lastTrackers?.sessionCookieTrackers.keys() ?? []) {
    lastTrackers?.stopTrackingSessionCookies(filePath)
  }
  vi.resetModules()
  lastTrackers = await import('./browser-session-cookie-tracker')
  const jar = fakeSession(rejectedSets)
  sessions.set(PARTITION, jar)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every Session member this code path calls.
  const target = jar as unknown as Session
  const snapshots = await import('./browser-session-cookie-snapshot-file')
  snapshots.configureBrowserSessionCookieSnapshots(directory)
  const restore = await import('./browser-session-cookie-restore')
  const clear = await import('./browser-session-cookie-clear')
  const retire = await import('./browser-session-cookie-route-restore')
  decryptFails = options.unreadable ?? false
  for (const name of options.unrestorable ?? []) {
    rejectedSets.add(name)
  }
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
    rejectedSets.clear()
  }
  return { jar, target, clear, restore, retire, snapshots }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-session-cookie-restore-'))
  decryptFails = false
  sealing = true
  Object.assign(io, {
    rmCalls: 0,
    rmFailures: 0,
    rmHold: null,
    writes: 0,
    cdpReads: 0,
    cdpReply: undefined
  })
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

/** What the snapshot file holds (the fake secret store seals as plain text). */
function storedCookies(): CdpCookie[] {
  const persisted = JSON.parse(readFileSync(snapshotFile(), 'utf8'))
  return JSON.parse(Buffer.from(persisted.cookies, 'base64').toString('utf8'))
}

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

  it('a full clear whose removal failed is retried even when reading the jar then fails', async () => {
    const { target, clear } = await savedButUnread()
    io.rmFailures = 1
    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('EBUSY')
    // Electron's read works, but the CDP read of the whole jar fails.
    io.cdpReply = {}

    await elapse(30_000)

    expect(existsSync(snapshotFile())).toBe(false)
    expect((await launch()).jar.names()).toEqual([])
  })

  it('quit makes the last removal without waiting on a retry that would read the jar', async () => {
    const { jar, target, clear, restore } = await savedButUnread()
    io.rmFailures = 1
    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('EBUSY')
    // An import holds the jar's cookie lock all the way through quit.
    const { withCookieMutationLock } = await import('../mutation/cookie-mutation-lock')
    let releaseLock = () => {}
    const held = withCookieMutationLock(
      target,
      () => new Promise<void>((resolve) => (releaseLock = resolve))
    )
    let releaseRemoval = () => {}
    io.rmHold = new Promise((resolve) => (releaseRemoval = resolve))
    io.rmFailures = 1
    // The timer's retry is now held in its removal, which will fail.
    await vi.advanceTimersByTimeAsync(30_000)
    const releaseReads = jar.holdReads()
    const quit = restore.flushBrowserSessionCookiesOnQuit()
    io.rmHold = null
    releaseRemoval()

    try {
      // Settles with every jar read and the cookie lock still held.
      await quit
      expect(existsSync(snapshotFile())).toBe(false)
    } finally {
      releaseReads()
      releaseLock()
      await held
    }
  })

  it('quit makes the last removal without waiting on a retry queued behind the cookie lock', async () => {
    const { jar, target, clear, restore } = await savedButUnread()
    io.rmFailures = 1
    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('EBUSY')
    const { withCookieMutationLock } = await import('../mutation/cookie-mutation-lock')
    let releaseLock = () => {}
    // An import holds the jar's cookie lock, so the timer's retry waits for it after its failed removal.
    const held = withCookieMutationLock(
      target,
      () => new Promise<void>((resolve) => (releaseLock = resolve))
    )
    io.rmFailures = 1
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    const releaseReads = jar.holdReads()
    const quit = restore.flushBrowserSessionCookiesOnQuit()
    releaseLock()
    await held

    try {
      // Settles with every jar read still held.
      await quit
      expect(existsSync(snapshotFile())).toBe(false)
    } finally {
      releaseReads()
    }
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

  it('a Google clear after a retirement whose removal failed reports it unverified', async () => {
    const { retire } = await signedIn()
    io.rmFailures = 1
    retire.forgetBrowserSessionCookies('default')

    expect(await clearGoogle()).toBe('unverified')
    expect(existsSync(snapshotFile())).toBe(true)
  })

  it('a full clear after a retirement whose removal failed fails', async () => {
    const { target, clear, retire } = await signedIn()
    io.rmFailures = 1
    retire.forgetBrowserSessionCookies('default')

    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('not_persisted')
  })

  it('a Google clear admitted before a retirement answers with that retirement', async () => {
    const { jar, retire } = await signedIn()
    const releaseFlush = jar.holdFlush()
    const flushing = jar.flushEntered()
    const clearing = clearGoogle()
    // The clear is admitted and past its live deletion once it reaches the native flush.
    await flushing
    io.rmFailures = 1
    retire.forgetBrowserSessionCookies('default')
    releaseFlush()

    expect(await clearing).toBe('unverified')
  })

  it('a Google clear after a retirement that removed the file reports it cleared', async () => {
    const { retire } = await signedIn()
    retire.forgetBrowserSessionCookies('default')

    expect(await clearGoogle()).toBe('cleared')
    expect(existsSync(snapshotFile())).toBe(false)
    expect((await launch()).jar.names()).toEqual([])
  })

  it('a quit save held while the profile is retired does not write the file back', async () => {
    const { jar, restore, retire } = await signedIn()
    await jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()
    const release = jar.holdReads()
    const quit = restore.flushBrowserSessionCookiesOnQuit()
    await settle()
    const writes = io.writes
    retire.forgetBrowserSessionCookies('default')
    release()
    await quit

    // Not even for a moment: no write lands after the retirement.
    expect(io.writes).toBe(writes)
    while (existsSync(snapshotFile())) {
      await settle()
    }
  })
})

describe('session cookie clear and quit ordering', () => {
  const isGoogle = (cookie: CdpCookie) => cookie.domain === 'google.com'

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('quit waits for a clear still flushing the native store', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com'), sessionCookie('SID', 'google.com')])
    const { jar, target, clear, restore } = await launch()
    await jar.cookies.remove('https://google.com/', 'SID')
    const releaseFlush = jar.holdFlush()
    const clearing = clear.persistBrowserCookieClear(target, isGoogle)
    await settle()
    let quitDone = false
    const quit = restore.flushBrowserSessionCookiesOnQuit().then(() => (quitDone = true))
    await settle()
    await settle()

    expect(quitDone).toBe(false)
    releaseFlush()
    expect(await clearing).toBe(true)
    await quit
    expect((await launch()).jar.names()).toEqual(['sid'])
  })

  it('a change during a failed rewrite gets its own save', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    const { jar, target, clear } = await launch()
    io.rmFailures = Number.POSITIVE_INFINITY
    await expect(clear.clearBrowserCookieJar(target)).rejects.toThrow('EBUSY')
    const release = jar.holdReads()
    await vi.advanceTimersByTimeAsync(30_000)
    await jar.cookies.set({ url: 'https://example.org/', name: 'brief' })
    await jar.cookies.remove('https://example.org/', 'brief')
    await settle()
    release()
    await writesDone()

    expect(io.rmCalls).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('a full clear of an unread file still counts when reading the jar afterwards fails', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    const { jar, target, clear } = await launch({ unreadable: true })
    jar.failNextRead()

    await clear.clearBrowserCookieJar(target)

    expect(existsSync(snapshotFile())).toBe(false)
  })
})

describe('CDP cookie reply for a saved read', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  async function changedAfterLaunch() {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    const launched = await launch()
    await launched.jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()
    return { ...launched, before: readFileSync(snapshotFile()) }
  }

  const invalid = [{}, { cookies: null }, { cookies: [null] }, { cookies: [{ name: 'x' }] }]
  for (const reply of [...invalid, { cookies: [{ name: 'x', value: 'y' }] }]) {
    it(`a save whose reply is ${JSON.stringify(reply)} fails and leaves the file`, async () => {
      const { before } = await changedAfterLaunch()
      io.cdpReply = reply

      await elapse(30_000)

      expect(io.cdpReads).toBe(1)
      expect(readFileSync(snapshotFile())).toEqual(before)
    })
  }

  it('a save whose reply is a valid empty jar removes the file', async () => {
    await changedAfterLaunch()
    io.cdpReply = { cookies: [] }

    await elapse(30_000)

    expect(existsSync(snapshotFile())).toBe(false)
  })
})

describe('session cookie snapshot with a cookie launch could not restore', () => {
  async function partlyRestored() {
    await saveSnapshot([sessionCookie('sid', 'example.com'), sessionCookie('other', 'example.net')])
    const partial = await launch({ unrestorable: ['sid'] })
    expect(partial.jar.names()).toEqual(['other'])
    // The launch's own CDP merge read doesn't count.
    io.cdpReads = 0
    return partial
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('a save that reads the live jar keeps it', async () => {
    const { jar } = await partlyRestored()

    await jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()
    await elapse(30_000)

    expect(io.cdpReads).toBe(1)
    expect((await launch()).jar.names()).toEqual(['new', 'other', 'sid'])
  })

  it('a save on quit keeps it', async () => {
    const { jar, restore } = await partlyRestored()

    await jar.cookies.set({ url: 'https://example.org/', name: 'new', secure: true })
    await settle()
    await restore.flushBrowserSessionCookiesOnQuit()

    expect((await launch()).jar.names()).toEqual(['other', 'sid'])
  })

  it('a change to its unpartitioned twin keeps the partitioned one it shares a scope with', async () => {
    const partitioned: CdpCookie = {
      ...sessionCookie('sid', 'example.com'),
      partitionKey: { topLevelSite: 'https://a.example', hasCrossSiteAncestor: false }
    }
    await saveSnapshot([sessionCookie('sid', 'example.com'), partitioned])
    const { jar } = await launch()
    expect(jar.names()).toEqual(['sid'])
    io.cdpReads = 0

    await jar.cookies.set({
      url: 'https://example.com/',
      name: 'sid',
      value: 'newer',
      secure: true
    })
    await settle()
    await elapse(30_000)

    expect(io.cdpReads).toBe(1)
    const persisted = JSON.parse(readFileSync(snapshotFile(), 'utf8'))
    const saved: CdpCookie[] = JSON.parse(Buffer.from(persisted.cookies, 'base64').toString('utf8'))
    expect(saved.map((cookie) => [cookie.value, cookie.partitionKey?.topLevelSite])).toEqual([
      ['newer', undefined],
      ['sid-value', 'https://a.example']
    ])
  })

  it('a persistent cookie that replaced it settles it, so the old session one is not kept', async () => {
    const { jar } = await partlyRestored()

    const expirationDate = Date.now() / 1000 + 3600
    await jar.cookies.set({
      url: 'https://example.com/',
      name: 'sid',
      expirationDate,
      secure: true
    })
    await settle()
    await elapse(30_000)

    expect(io.cdpReads).toBe(1)
    expect(storedCookies().map((cookie) => cookie.name)).toEqual(['other'])
  })

  it('an opaque-partition twin keeps its saved value at quit when the unpartitioned one changes', async () => {
    const opaque: CdpCookie = { ...sessionCookie('sid', 'example.com'), partitionKeyOpaque: true }
    await saveSnapshot([sessionCookie('sid', 'example.com'), opaque])
    const { jar, restore } = await launch({ unrestorable: ['sid'] })

    await jar.cookies.set({
      url: 'https://example.com/',
      name: 'sid',
      value: 'newer',
      secure: true
    })
    await settle()
    await restore.flushBrowserSessionCookiesOnQuit()

    expect(storedCookies().map((cookie) => [cookie.value, cookie.partitionKeyOpaque])).toEqual([
      ['newer', undefined],
      ['sid-value', true]
    ])
  })

  it('a real sign-out elsewhere and a newer value for it still stick', async () => {
    const { jar } = await partlyRestored()

    await jar.cookies.remove('https://example.net/', 'other')
    await jar.cookies.set({
      url: 'https://example.com/',
      name: 'sid',
      value: 'newer',
      secure: true
    })
    await settle()
    await elapse(30_000)

    const relaunched = await launch()
    expect(relaunched.jar.names()).toEqual(['sid'])
    expect((await relaunched.jar.cookies.get()).map((cookie) => cookie.value)).toEqual(['newer'])
  })
})

describe('a cookie clear, quit and retirement at the real callers', () => {
  const ROUTE = `persist:orca-browser-v1-${'a'.repeat(64)}`
  const signedIn = async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com'), sessionCookie('SID', 'google.com')])
    return launch()
  }
  const settleUntil = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) {
      await settle()
    }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  it('quit waits for a Google clear admitted before its live deletion', async () => {
    const { jar, restore } = await signedIn()
    // The restore's own cookie events are saved first, so quit has nothing of its own to read.
    await settle()
    await elapse(30_000)
    const release = jar.holdReads()
    const clearing = clearGoogle()
    await settle()
    let quitDone = false
    const quit = restore.flushBrowserSessionCookiesOnQuit().then(() => (quitDone = true))
    await settleUntil(() => quitDone)

    expect(quitDone).toBe(false)
    release()
    expect(await clearing).toBe('cleared')
    await quit
    expect((await launch()).jar.names()).toEqual(['sid'])
  })

  it('a Google clear revoked midway persists nothing', async () => {
    await signedIn()
    const before = readFileSync(snapshotFile())
    let checks = 0
    const google = await import('../browser-google-cookie-clear')

    const result = await google.clearGoogleCookiesFromPartition(PARTITION, () => {
      checks += 1
      if (checks > 1) {
        throw new Error('The browser profile connection changed. Try again.')
      }
    })

    expect(result).toBe('unverified')
    expect(readFileSync(snapshotFile())).toEqual(before)
  })

  it('a later retirement that left the file answers a clear with its own receipt', async () => {
    const { retire, snapshots } = await signedIn()
    retire.forgetBrowserSessionCookies('default')
    await settleUntil(() => !existsSync(snapshotFile()))
    // The file is back (written outside this jar's tracking), and its next retirement can't remove it.
    await snapshots.writeSessionCookieSnapshot(snapshotFile(), [sessionCookie('SID', 'google.com')])
    io.rmFailures = 1
    retire.forgetBrowserSessionCookies('default')

    expect(await clearGoogle()).toBe('unverified')
  })

  it('quit waits for a retirement still removing its file', async () => {
    const { restore, retire } = await signedIn()
    let releaseRemoval = () => {}
    io.rmHold = new Promise((resolve) => (releaseRemoval = resolve))
    retire.forgetBrowserSessionCookies('default')
    await settle()
    let quitDone = false
    const quit = restore.flushBrowserSessionCookiesOnQuit().then(() => (quitDone = true))
    await settleUntil(() => quitDone)

    expect(quitDone).toBe(false)
    io.rmHold = null
    releaseRemoval()
    await quit
    expect(existsSync(snapshotFile())).toBe(false)
  })

  it('a Google clear queued behind quit edits what quit wrote, so a sign-out sticks', async () => {
    const { jar, restore } = await signedIn()
    await jar.cookies.remove('https://example.com/', 'sid')
    await settle()
    const release = jar.holdReads()
    const quit = restore.flushBrowserSessionCookiesOnQuit()
    await settle()
    const clearing = clearGoogle()
    await settle()
    release()
    await quit
    await clearing

    expect((await launch()).jar.names()).toEqual([])
  })

  it('a full clear of an unread file settles without reading the jar, and later cookies save', async () => {
    await saveSnapshot([sessionCookie('sid', 'example.com')])
    const { jar, target, clear } = await launch({ unreadable: true })
    const release = jar.holdReads()
    // Settles with every jar read still held.
    await clear.clearBrowserCookieJar(target)

    await jar.cookies.set({ url: 'https://example.org/', name: 'after', secure: true })
    release()
    await settle()
    await elapse(30_000)
    expect((await launch()).jar.names()).toEqual(['after'])
  })

  // Two failures: the timer's removal fails too, and the sealed write of the new cookie replaces the file.
  it.each([1, 2])(
    'a whole clear of an unread file whose removal failed %i time(s) still saves cookies set meanwhile',
    async (rmFailures) => {
      await saveSnapshot([sessionCookie('sid', 'example.com')])
      const { jar, target, clear } = await launch({ unreadable: true })
      const releaseFlush = jar.holdFlush()
      const clearing = clear.clearBrowserCookieJar(target)
      await settle()
      // Set after the native clear, while the file is still unread: the event isn't recorded.
      await jar.cookies.set({ url: 'https://example.org/', name: 'during', secure: true })
      await settle()
      io.rmFailures = rmFailures
      releaseFlush()
      await expect(clearing).rejects.toThrow('EBUSY')

      await elapse(30_000)

      expect(storedCookies().map((cookie) => cookie.name)).toEqual(['during'])
      expect((await launch()).jar.names()).toEqual(['during'])
    }
  )

  it('a route jar being retired is not restored again until its release', async () => {
    const { retire } = await launch()
    sessions.set(ROUTE, fakeSession())
    const tracked = () => lastTrackers?.sessionCookieTrackers.size
    await retire.restoreBrowserRoutePartitionSessionCookies(ROUTE)
    expect(tracked()).toBe(2)

    await retire.forgetBrowserRoutePartitionSessionCookies(ROUTE)
    await retire.restoreBrowserRoutePartitionSessionCookies(ROUTE)
    expect(tracked()).toBe(1)

    retire.releaseRetiredRoutePartitions([ROUTE])
    await retire.restoreBrowserRoutePartitionSessionCookies(ROUTE)
    expect(tracked()).toBe(2)
  })
})
