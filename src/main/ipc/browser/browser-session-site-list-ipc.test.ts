import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
const showMessageBox = vi.fn()
const persist = vi.fn()

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
vi.mock('./browser-renderer-trust', () => ({ isTrustedBrowserRenderer: () => true }))
vi.mock('../../browser/sessions/profiles/browser-session-registry', () => ({
  browserSessionRegistry: {
    metadataPath: '/unused/browser-session-meta.json',
    defaultPartition: 'persist:orca-browser',
    getProfile: (id: string) => (id === 'p1' ? { id, label: 'Work' } : undefined)
  }
}))
vi.mock('../../browser/sessions/profiles/browser-session-meta-store', () => ({
  loadBrowserSessionMeta: vi.fn(),
  persistBrowserSessionMeta: (...args: unknown[]) => persist(...args)
}))

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

beforeEach(() => {
  handlers.clear()
  showMessageBox.mockReset()
  persist.mockReset()
  persist.mockReturnValue(true)
  setBrowserProfileSiteList('p1', [])
  registerBrowserSessionSiteListHandlers()
})

describe('setAllowedHosts persistence failure', () => {
  it('applies nothing and reports save-failed when the write fails', async () => {
    setBrowserProfileSiteList('p1', ['a.com'])
    showMessageBox.mockResolvedValue(ALLOW)
    persist.mockReturnValue(false)

    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: false, reason: 'save-failed' })
    expect(getBrowserProfileSiteListEntries('p1')).toEqual(['a.com'])
  })

  it('does not enforce a first list that could not be saved', async () => {
    persist.mockReturnValue(false)
    expect(await setHosts(['a.com'])).toEqual({ ok: false, reason: 'save-failed' })
    expect(getBrowserProfileSiteListEntries('p1')).toEqual([])
  })

  it('still asks before widening after a failed write', async () => {
    setBrowserProfileSiteList('p1', ['a.com'])
    showMessageBox.mockResolvedValue(ALLOW)
    persist.mockReturnValueOnce(false)
    await setHosts(['a.com', 'b.com'])
    expect(showMessageBox).toHaveBeenCalledTimes(1)

    // Memory and disk agree on ['a.com'], so adding b.com asks again instead of passing silently.
    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: true, hosts: ['a.com', 'b.com'] })
    expect(showMessageBox).toHaveBeenCalledTimes(2)
    expect(getBrowserProfileSiteListEntries('p1')).toEqual(['a.com', 'b.com'])
  })

  it('writes the lists of every profile, with the new one applied only after the write', async () => {
    await setHosts(['a.com'])
    expect(persist.mock.calls[0]?.[2]).toEqual({ allowedHostsByProfileId: { p1: ['a.com'] } })
  })
})

describe('setAllowedHosts confirmation', () => {
  it('narrows without asking and asks for additions and for clearing', async () => {
    setBrowserProfileSiteList('p1', ['a.com', 'b.com'])
    showMessageBox.mockResolvedValue(ALLOW)

    await setHosts(['a.com'])
    expect(showMessageBox).not.toHaveBeenCalled()
    await setHosts([])
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(getBrowserProfileSiteListEntries('p1')).toEqual([])
  })

  it('keeps the list and writes nothing when the dialog is cancelled', async () => {
    setBrowserProfileSiteList('p1', ['a.com'])
    showMessageBox.mockResolvedValue({ response: 1 })
    expect(await setHosts(['a.com', 'b.com'])).toEqual({ ok: false, reason: 'cancelled' })
    expect(persist).not.toHaveBeenCalled()
    expect(getBrowserProfileSiteListEntries('p1')).toEqual(['a.com'])
  })

  it('handles edits one at a time and judges the second against the list the first produced', async () => {
    setBrowserProfileSiteList('p1', ['a.com'])
    let release: (value: { response: number }) => void = () => {}
    showMessageBox.mockImplementationOnce(
      () => new Promise<{ response: number }>((resolve) => (release = resolve))
    )
    const first = setHosts(['a.com', 'b.com'])
    const second = setHosts(['a.com', 'b.com'])
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalledTimes(1))
    // The second edit has not reached its own check while the first dialog is open.
    expect(persist).not.toHaveBeenCalled()

    release(ALLOW)
    expect(await first).toEqual({ ok: true, hosts: ['a.com', 'b.com'] })
    // b.com is already on the list, so the second edit no longer widens and needs no dialog.
    expect(await second).toEqual({ ok: true, hosts: ['a.com', 'b.com'] })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('refuses an unknown profile and malformed entries', async () => {
    expect(await setHosts(['a.com'], 'nope')).toEqual({ ok: false, reason: 'unavailable' })
    expect(await setHosts(['com'])).toEqual({ ok: false, reason: 'invalid' })
    expect(persist).not.toHaveBeenCalled()
  })
})
