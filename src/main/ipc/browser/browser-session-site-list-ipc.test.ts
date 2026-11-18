import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const showMessageBox = vi.fn()
// An in-memory metadata file, so the real store and meta-store run end to end.
const disk = vi.hoisted(() => ({
  file: null as string | null,
  pending: '',
  failReads: 0,
  failWrites: false,
  writes: 0,
  trusted: true
}))

vi.mock('node:fs', () => ({
  mkdirSync: () => undefined,
  readFileSync: () => {
    if (disk.failReads > 0) {
      disk.failReads -= 1
      throw Object.assign(new Error('locked'), { code: 'EBUSY' })
    }
    if (disk.file === null) {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' })
    }
    return disk.file
  },
  writeFileSync: (_path: string, data: string) => {
    if (disk.failWrites) {
      throw new Error('EIO')
    }
    disk.pending = data
    disk.writes += 1
  },
  renameSync: () => {
    disk.file = disk.pending
  }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: { fromWebContents: () => ({ isDestroyed: () => false }) },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) }
}))
vi.mock('../../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: () => disk.trusted }))
vi.mock('../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    metadataPath: '/unused/browser-session-meta.json',
    defaultPartition: 'persist:orca-browser',
    getProfile: (id: string) =>
      id === 'p1' || id === 'p2' ? { id, label: id === 'p1' ? 'Work' : 'Home' } : undefined
  }
}))

import { loadPersistedBrowserProfileSiteLists } from '../../browser/sessions/site-list/browser-profile-site-list-store'
import {
  getBrowserProfileSiteListEntries,
  setBrowserProfileSiteList
} from '../../browser/sessions/site-list/browser-session-site-list'
import { registerBrowserSessionSiteListHandlers } from './browser-session-site-list-ipc'

const ALLOW = { response: 0 }
const sender = {}

function setHosts(hosts: string[], profileId = 'p1'): Promise<unknown> {
  const handler = handlers.get('browser:session:setAllowedHosts')!
  return Promise.resolve(handler({ sender }, { profileId, hosts }))
}

function getHosts(profileId = 'p1'): unknown {
  return handlers.get('browser:session:getAllowedHosts')!({ sender }, { profileId })
}

function listsOnDisk(): unknown {
  return JSON.parse(disk.file ?? '{}').allowedHostsByProfileId
}

function startWithFile(lists: Record<string, string[]> | null): void {
  disk.file = lists === null ? null : JSON.stringify({ allowedHostsByProfileId: lists })
  loadPersistedBrowserProfileSiteLists()
}

beforeEach(() => {
  handlers.clear()
  showMessageBox.mockReset()
  Object.assign(disk, { file: null, pending: '', failReads: 0, failWrites: false, writes: 0 })
  disk.trusted = true
  setBrowserProfileSiteList('p1', [])
  setBrowserProfileSiteList('p2', [])
  registerBrowserSessionSiteListHandlers()
})

describe('setAllowedHosts trust', () => {
  it('refuses an untrusted sender and changes nothing, then works for a trusted one', async () => {
    startWithFile({ p1: ['a.com'] })
    disk.trusted = false
    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: false, reason: 'unavailable' })
    expect(getHosts()).toBeNull()
    expect(disk.writes).toBe(0)
    expect(getBrowserProfileSiteListEntries('p1')).toEqual(['a.com'])

    disk.trusted = true
    showMessageBox.mockResolvedValue(ALLOW)
    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: true, hosts: ['a.com', 'b.com'] })
  })
})

describe('setAllowedHosts persistence', () => {
  it('applies nothing and reports save-failed when the file write throws', async () => {
    startWithFile({ p1: ['a.com'] })
    showMessageBox.mockResolvedValue(ALLOW)
    disk.failWrites = true

    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: false, reason: 'save-failed' })
    expect(getBrowserProfileSiteListEntries('p1')).toEqual(['a.com'])
    expect(listsOnDisk()).toEqual({ p1: ['a.com'] })
  })

  it('does not enforce a first list that could not be saved', async () => {
    startWithFile(null)
    disk.failWrites = true
    expect(await setHosts(['a.com'])).toEqual({ ok: false, reason: 'save-failed' })
    expect(getBrowserProfileSiteListEntries('p1')).toEqual([])
  })

  it('asks again before widening after a failed write', async () => {
    startWithFile({ p1: ['a.com'] })
    showMessageBox.mockResolvedValue(ALLOW)
    disk.failWrites = true
    await setHosts(['a.com', 'b.com'])
    disk.failWrites = false

    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: true, hosts: ['a.com', 'b.com'] })
    expect(showMessageBox).toHaveBeenCalledTimes(2)
  })

  it("keeps other profiles' lists on disk and drops lists of deleted profiles", async () => {
    startWithFile({ p1: ['a.com'], p2: ['keep.com'] })
    showMessageBox.mockResolvedValue(ALLOW)
    // A list for a profile that no longer exists, as left by an older build.
    disk.file = JSON.stringify({ allowedHostsByProfileId: { p1: ['a.com'], p2: ['keep.com'], gone: ['x.com'] } })

    expect(await setHosts(['a.com'])).toEqual({ ok: true, hosts: ['a.com'] })
    expect(listsOnDisk()).toEqual({ p1: ['a.com'], p2: ['keep.com'] })
    expect(await setHosts([])).toMatchObject({ ok: true })
    expect(listsOnDisk()).toEqual({ p2: ['keep.com'] })
  })
})

describe('unreadable saved lists', () => {
  it('refuses edits and never rewrites the file while the startup read fails', async () => {
    disk.file = JSON.stringify({ allowedHostsByProfileId: { p1: ['a.com'], p2: ['b.com'] } })
    const before = disk.file
    disk.failReads = 100
    expect(loadPersistedBrowserProfileSiteLists()).toBe(false)

    expect(await setHosts(['c.com'], 'p1')).toEqual({ ok: false, reason: 'load-failed' })
    expect(await setHosts([], 'p2')).toEqual({ ok: false, reason: 'load-failed' })
    expect(getHosts()).toBeNull()
    expect(disk.writes).toBe(0)
    expect(disk.file).toBe(before)
  })

  it('recovers once the file can be read again, then enforces and merges correctly', async () => {
    disk.file = JSON.stringify({ allowedHostsByProfileId: { p1: ['a.com'], p2: ['b.com'] } })
    disk.failReads = 100
    loadPersistedBrowserProfileSiteLists()
    disk.failReads = 0

    expect(getHosts('p1')).toEqual(['a.com'])
    expect(getBrowserProfileSiteListEntries('p2')).toEqual(['b.com'])
    showMessageBox.mockResolvedValue(ALLOW)
    expect(await setHosts(['a.com', 'c.com'])).toMatchObject({ ok: true })
    expect(listsOnDisk()).toEqual({ p1: ['a.com', 'c.com'], p2: ['b.com'] })
  })

  it('retries the startup read once, so one brief lock does not disable enforcement', () => {
    disk.file = JSON.stringify({ allowedHostsByProfileId: { p1: ['a.com'] } })
    disk.failReads = 1
    expect(loadPersistedBrowserProfileSiteLists()).toBe(true)
    expect(getBrowserProfileSiteListEntries('p1')).toEqual(['a.com'])
  })

  it('treats a missing file as empty and a corrupt file as unreadable', async () => {
    disk.file = null
    expect(loadPersistedBrowserProfileSiteLists()).toBe(true)
    expect(await setHosts(['a.com'])).toEqual({ ok: true, hosts: ['a.com'] })

    disk.file = '{not json'
    expect(loadPersistedBrowserProfileSiteLists()).toBe(false)
    expect(await setHosts(['b.com'])).toEqual({ ok: false, reason: 'load-failed' })
    expect(disk.file).toBe('{not json')
  })

  it('fails the save, not the file, when the re-read just before the write fails', async () => {
    startWithFile({ p1: ['a.com'], p2: ['b.com'] })
    const before = disk.file
    disk.failReads = 1
    expect(await setHosts(['a.com'])).toEqual({ ok: false, reason: 'load-failed' })
    expect(disk.file).toBe(before)
  })
})

describe('setAllowedHosts confirmation', () => {
  it('narrows without asking and asks for additions and for clearing', async () => {
    startWithFile({ p1: ['a.com', 'b.com'] })
    showMessageBox.mockResolvedValue(ALLOW)

    await setHosts(['a.com'])
    expect(showMessageBox).not.toHaveBeenCalled()
    await setHosts([])
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(getBrowserProfileSiteListEntries('p1')).toEqual([])
  })

  it('keeps the list and writes nothing when the dialog is cancelled', async () => {
    startWithFile({ p1: ['a.com'] })
    showMessageBox.mockResolvedValue({ response: 1 })
    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: false, reason: 'cancelled' })
    expect(disk.writes).toBe(0)
    expect(getBrowserProfileSiteListEntries('p1')).toEqual(['a.com'])
  })

  it('refuses without prompting again when the list changed so the edit widens further', async () => {
    startWithFile({ p1: ['a.com'] })
    showMessageBox.mockImplementationOnce(async () => {
      // While the dialog is open the list is replaced, so the edit now also adds a.com.
      setBrowserProfileSiteList('p1', ['z.com'])
      return ALLOW
    })
    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: false, reason: 'changed' })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(disk.writes).toBe(0)
  })

  it('handles edits one at a time and judges the second against the list the first produced', async () => {
    startWithFile({ p1: ['a.com'] })
    let release: (value: { response: number }) => void = () => {}
    showMessageBox.mockImplementationOnce(
      () => new Promise<{ response: number }>((resolve) => (release = resolve))
    )
    const first = setHosts(['a.com', 'b.com'])
    const second = setHosts(['a.com', 'b.com'])
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1))
    expect(disk.writes).toBe(0)

    release(ALLOW)
    expect(await first).toEqual({ ok: true, hosts: ['a.com', 'b.com'] })
    // b.com is already on the list, so the second edit no longer widens and needs no dialog.
    expect(await second).toEqual({ ok: true, hosts: ['a.com', 'b.com'] })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown profile and malformed entries', async () => {
    expect(await setHosts(['a.com'], 'nope')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await setHosts(['com'])).toEqual({ ok: false, reason: 'invalid' })
    expect(disk.writes).toBe(0)
  })
})
