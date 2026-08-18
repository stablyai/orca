import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as CookieStagingModule from './browser-session-cookie-staging'

const {
  sessionFromPartitionMock,
  removeNonTransplantableCookiesMock,
  clearPendingNonTransplantableMock,
  userData
} = vi.hoisted(() => ({
  sessionFromPartitionMock: vi.fn(),
  removeNonTransplantableCookiesMock: vi.fn(),
  clearPendingNonTransplantableMock: vi.fn(),
  // Why: the registry persists staging metadata under userData, so the real staging module needs a
  // writable path or every persist silently swallows its own failure and the test proves nothing.
  userData: { path: '' }
}))

vi.mock('electron', () => ({
  app: { getPath: () => userData.path },
  session: { fromPartition: sessionFromPartitionMock },
  systemPreferences: { askForMediaAccess: vi.fn(), getMediaAccessStatus: vi.fn() }
}))

vi.mock('./browser-manager', () => ({
  browserManager: {
    notifyPermissionDenied: vi.fn(),
    handleGuestWillDownload: vi.fn(),
    installCertificateRequestGuard: vi.fn(),
    removeCertificateRequestGuard: vi.fn()
  }
}))

vi.mock('./browser-cookie-import-clear', () => ({
  removeNonTransplantableCookies: removeNonTransplantableCookiesMock
}))

vi.mock('./browser-session-cookie-staging', async (importOriginal) => ({
  ...(await importOriginal<typeof CookieStagingModule>()),
  clearPendingBrowserCookieImportNonTransplantable: clearPendingNonTransplantableMock
}))

import { browserSessionRegistry } from './browser-session-registry'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  getOrcaProfileBrowserDefaultPartition
} from '../../shared/orca-profiles'

// Why: the registry persists metadata under app.getPath('userData'). Without a real path here the
// mock returns '' and the meta file lands in the repo root — this test already committed one.
let userDataDir: string

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-registry-userdata-'))
  userData.path = userDataDir
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('BrowserSessionRegistry.clearProfileNonTransplantableCookies', () => {
  beforeEach(() => {
    removeNonTransplantableCookiesMock.mockReset().mockResolvedValue(undefined)
    clearPendingNonTransplantableMock.mockReset()
    sessionFromPartitionMock.mockReset().mockImplementation((partition: string) => ({
      partition,
      cookies: { get: vi.fn(), remove: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }))
  })

  // Why: the settings row renders per profile, so a clear that resolved the default partition would
  // sign the user out of Google in a profile they were not looking at.
  it('clears the requested profile partition, not the default one', async () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Work')
    expect(profile).not.toBeNull()

    await expect(
      browserSessionRegistry.clearProfileNonTransplantableCookies(profile!.id)
    ).resolves.toBe(true)

    expect(sessionFromPartitionMock).toHaveBeenCalledWith(profile!.partition)
    const [lockOwner, store] = removeNonTransplantableCookiesMock.mock.calls[0] ?? []
    expect(lockOwner).toMatchObject({ partition: profile!.partition })
    // Why: the same object an import locks on, and the session's own cookie jar — not a wrapper.
    expect(store).toBe(lockOwner.cookies)
  })

  // Why (#14686): a pending staged DB holds the pre-clear rows of this very family and is copied
  // back over the jar at the next cold start, so clearing only the live session hands the Google
  // session straight back — after the user confirmed a dialog saying it would be gone.
  it('also strips the family from a pending staged import for that partition', async () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Staged')

    await browserSessionRegistry.clearProfileNonTransplantableCookies(profile!.id)

    expect(clearPendingNonTransplantableMock).toHaveBeenCalledOnce()
    expect(clearPendingNonTransplantableMock.mock.calls[0]?.[0]).toMatchObject({
      partition: profile!.partition
    })
  })

  // Why (#14686): registration compares this mark against the one taken when the staged snapshot was
  // made. Without the bump an in-flight import registers a pre-clear snapshot and the replay
  // resurrects the session at next launch.
  it('advances the partition clear mark so an in-flight import strips its staged snapshot', async () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Marked')
    const before = browserSessionRegistry.nonTransplantableClearMark(profile!.partition)

    await browserSessionRegistry.clearProfileNonTransplantableCookies(profile!.id)

    expect(browserSessionRegistry.nonTransplantableClearMark(profile!.partition)).not.toBe(before)
  })

  // Why: a failed clear removed nothing, so advancing the mark would make a staged replay look
  // stale and discard rows the user never cleared.
  it('leaves the clear mark alone when the removal fails', async () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Unmarked')
    removeNonTransplantableCookiesMock.mockRejectedValue(new Error('cookie store busy'))
    const before = browserSessionRegistry.nonTransplantableClearMark(profile!.partition)

    await browserSessionRegistry.clearProfileNonTransplantableCookies(profile!.id)

    expect(browserSessionRegistry.nonTransplantableClearMark(profile!.partition)).toBe(before)
  })

  it('reports failure and touches nothing for an unknown profile', async () => {
    await expect(
      browserSessionRegistry.clearProfileNonTransplantableCookies('no-such-profile')
    ).resolves.toBe(false)

    expect(removeNonTransplantableCookiesMock).not.toHaveBeenCalled()
    expect(clearPendingNonTransplantableMock).not.toHaveBeenCalled()
  })

  // Why: reporting success after a failed removal would tell the user a live session is gone.
  it('reports failure and leaves the staged import alone when the removal throws', async () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Failing')
    removeNonTransplantableCookiesMock.mockRejectedValue(new Error('cookie store busy'))

    await expect(
      browserSessionRegistry.clearProfileNonTransplantableCookies(profile!.id)
    ).resolves.toBe(false)

    expect(clearPendingNonTransplantableMock).not.toHaveBeenCalled()
  })
})

describe('BrowserSessionRegistry staged-import cleanup', () => {
  let workDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'orca-registry-staged-'))
    userData.path = workDir
    sessionFromPartitionMock.mockReset().mockImplementation((partition: string) => ({
      partition,
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined),
      setUserAgent: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }))
  })

  function stageFor(partition: string): string {
    const stagedPath = join(workDir, `Cookies-${partition.replace(':', '-')}`)
    writeFileSync(stagedPath, 'staged cookie database')
    writeFileSync(`${stagedPath}-wal`, 'wal')
    browserSessionRegistry.setPendingCookieImport(partition, stagedPath)
    return stagedPath
  }

  // Why (#14686): one bump only SWAPS which half of the wipe window is open. Bumping before the
  // await leaves an import that snapshots mid-wipe comparing equal at registration, so the mark has
  // to move on both sides. Holding clearStorageData pending makes that deterministic — this is the
  // ordering the placement was chosen for, so it should not be the one property left uncovered.
  it('advances the profile clear mark on both sides of the wipe', async () => {
    const partition = getOrcaProfileBrowserDefaultPartition(DEFAULT_LOCAL_ORCA_PROFILE_ID)
    let resolveWipe: () => void = () => undefined
    const wipe = new Promise<void>((resolve) => {
      resolveWipe = resolve
    })
    sessionFromPartitionMock.mockReturnValue({
      clearStorageData: () => wipe,
      clearCache: vi.fn().mockResolvedValue(undefined),
      cookies: { get: vi.fn(), remove: vi.fn() },
      on: vi.fn(),
      removeListener: vi.fn()
    })
    const before = browserSessionRegistry.profileCookieClearMark(partition)

    const clearing = browserSessionRegistry.clearDefaultSessionCookies()
    // Why: an import snapshotting right here copies a jar that is NOT yet wiped.
    const midWipe = browserSessionRegistry.profileCookieClearMark(partition)
    expect(midWipe).not.toBe(before)

    resolveWipe()
    await expect(clearing).resolves.toBe(true)

    // Why: so that mid-wipe snapshot compares unequal when it finally registers.
    expect(browserSessionRegistry.profileCookieClearMark(partition)).not.toBe(midWipe)
  })

  // Why (#14686): a profile-wide wipe has the same in-flight-import window as the Google clear, and
  // no staged entry exists yet to drop when the clear runs early. The mark is what lets the import
  // discard its own pre-wipe snapshot at registration instead of replaying it at the next launch.
  it('advances the profile clear mark so an in-flight import discards its snapshot', async () => {
    const partition = getOrcaProfileBrowserDefaultPartition(DEFAULT_LOCAL_ORCA_PROFILE_ID)
    const before = browserSessionRegistry.profileCookieClearMark(partition)

    await expect(browserSessionRegistry.clearDefaultSessionCookies()).resolves.toBe(true)

    expect(browserSessionRegistry.profileCookieClearMark(partition)).not.toBe(before)
    // Why: a full wipe must not masquerade as a Google clear — the two need different remedies.
    expect(browserSessionRegistry.nonTransplantableClearMark(partition)).toBe(0)
  })

  // Why (#14686): the staged DB is a byte copy of this profile's jar, Google rows included. Dropping
  // only the metadata pointer would leave that copy in userData forever — no sweeper reclaims it —
  // while the confirmation told the user every cookie in the profile was deleted.
  it('unlinks the staged import file when the default profile cookies are cleared', async () => {
    const stagedPath = stageFor(
      getOrcaProfileBrowserDefaultPartition(DEFAULT_LOCAL_ORCA_PROFILE_ID)
    )

    await expect(browserSessionRegistry.clearDefaultSessionCookies()).resolves.toBe(true)

    expect(existsSync(stagedPath)).toBe(false)
    expect(existsSync(`${stagedPath}-wal`)).toBe(false)
  })

  it('unlinks the staged import file when the profile itself is deleted', async () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Staged Delete')
    const stagedPath = stageFor(profile!.partition)

    await expect(browserSessionRegistry.deleteProfile(profile!.id)).resolves.toBe(true)

    expect(existsSync(stagedPath)).toBe(false)
    expect(existsSync(`${stagedPath}-wal`)).toBe(false)
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })
})
