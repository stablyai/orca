import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const showMessageBox = vi.fn()
const state = vi.hoisted(() => ({ dir: '', trusted: true }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, fn),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: {
    fromWebContents: () => ({
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false
    })
  },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) }
}))
vi.mock('../../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: () => state.trusted }))
vi.mock('../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    get metadataPath() {
      return join(state.dir, 'browser-session-meta.json')
    },
    defaultPartition: 'persist:orca-browser',
    getProfile: (id: string) => (id === 'p1' || id === 'p2' ? { id, label: id } : undefined)
  }
}))

import { setBrowserProfileSiteList } from '../../browser/sessions/site-list/browser-session-site-list'
import { registerBrowserSessionSiteListHandlers } from './browser-session-site-list-ipc'

const metaPath = (): string => join(state.dir, 'browser-session-meta.json')
const setHosts = async (hosts: string[], profileId = 'p1'): Promise<unknown> =>
  handlers.get('browser:session:setAllowedHosts')!({ sender: {} }, { profileId, hosts })
const getHosts = async (profileId = 'p1'): Promise<unknown> =>
  handlers.get('browser:session:getAllowedHosts')!({ sender: {} }, { profileId })

// Mirrors startup: the lists are in memory and on disk.
function startWithLists(lists: Record<string, string[]>): void {
  writeFileSync(metaPath(), JSON.stringify({ allowedHostsByProfileId: lists }))
  for (const [profileId, entries] of Object.entries(lists)) {
    setBrowserProfileSiteList(profileId, entries)
  }
}

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'site-list-'))
  state.trusted = true
  handlers.clear()
  showMessageBox.mockReset()
  setBrowserProfileSiteList('p1', [])
  setBrowserProfileSiteList('p2', [])
  registerBrowserSessionSiteListHandlers()
})

afterEach(() => rmSync(state.dir, { recursive: true, force: true }))

describe('browser profile site list IPC', () => {
  it('ignores an untrusted sender', async () => {
    startWithLists({ p1: ['a.com'] })
    const before = readFileSync(metaPath(), 'utf-8')
    state.trusted = false

    expect(await setHosts([])).toEqual({ ok: false, reason: 'unavailable' })
    expect(await getHosts()).toBeNull()
    expect(readFileSync(metaPath(), 'utf-8')).toBe(before)
  })

  it('narrows silently, asks before widening, and keeps the list when cancelled', async () => {
    startWithLists({ p1: ['a.com', 'b.com'], p2: ['keep.com'] })

    expect(await setHosts(['a.com'])).toEqual({ ok: true, hosts: ['a.com'] })
    expect(showMessageBox).not.toHaveBeenCalled()

    showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await setHosts(['a.com', 'c.com'])).toEqual({ ok: false, reason: 'cancelled' })
    expect(await getHosts()).toEqual(['a.com'])

    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await setHosts(['a.com', 'c.com'])).toEqual({ ok: true, hosts: ['a.com', 'c.com'] })
    expect(JSON.parse(readFileSync(metaPath(), 'utf-8')).allowedHostsByProfileId).toEqual({
      p1: ['a.com', 'c.com'],
      p2: ['keep.com']
    })
  })

  it('keeps enforcing the old list when the write fails', async () => {
    startWithLists({ p1: ['a.com'] })
    mkdirSync(`${metaPath()}.site-list.tmp`)
    showMessageBox.mockResolvedValue({ response: 0 })

    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: false, reason: 'save-failed' })
    expect(await getHosts()).toEqual(['a.com'])
  })

  it('never rewrites a saved file it could not read', async () => {
    writeFileSync(metaPath(), '{not json')

    expect(await setHosts(['a.com'])).toEqual({ ok: false, reason: 'save-failed' })
    expect(await getHosts()).toBeNull()
    expect(readFileSync(metaPath(), 'utf-8')).toBe('{not json')
  })
})
