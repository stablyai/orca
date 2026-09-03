import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mocked } from 'vitest'
import type { Session } from 'electron'

const getAllWebContentsMock = vi.fn()
vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => getAllWebContentsMock() }
}))

import { findPartitionWebContents, resetBrowserProfilePartition } from './browser-profile-reset'
import { acquireCookieMutationLock, withCookieMutationLock } from './browser-cookie-import-clear'

type SessionMock = Session & Mocked<Pick<Session, 'clearData' | 'clearStorageData'>>

function makeSession(overrides: Partial<SessionMock> = {}): SessionMock {
  return {
    clearData: vi.fn<Session['clearData']>(async () => undefined),
    clearStorageData: vi.fn<Session['clearStorageData']>(async () => undefined),
    ...overrides
  } as SessionMock
}

function makeContents(session: unknown, opts: { destroyed?: boolean; onReload?: () => void } = {}) {
  return {
    session,
    isDestroyed: () => opts.destroyed === true,
    reload: vi.fn(() => opts.onReload?.())
  }
}

describe('resetBrowserProfilePartition', () => {
  beforeEach(() => {
    getAllWebContentsMock.mockReset()
    getAllWebContentsMock.mockReturnValue([])
  })

  it('rotates media-device IDs and clears the whole partition', async () => {
    const targetSession = makeSession()
    await resetBrowserProfilePartition({
      targetSession,
      partition: 'persist:orca-browser',
      clearPendingCookieImport: vi.fn(),
      clearImportedSource: vi.fn()
    })
    expect(targetSession.clearStorageData).toHaveBeenCalledTimes(1)
    expect(targetSession.clearStorageData).toHaveBeenCalledWith({ storages: ['cookies'] })
    expect(targetSession.clearData).toHaveBeenCalledTimes(1)
    expect(targetSession.clearData).toHaveBeenCalledWith()
  })

  it('forwards non-default partitions to staged-import deletion', async () => {
    const partition = 'persist:orca-browser-session-imported'
    const clearPendingCookieImport = vi.fn()
    await resetBrowserProfilePartition({
      targetSession: makeSession(),
      partition,
      clearPendingCookieImport,
      clearImportedSource: vi.fn()
    })
    expect(clearPendingCookieImport).toHaveBeenCalledWith(partition)
  })

  it('clears the imported-source badge before the data is gone', async () => {
    const order: string[] = []
    const clearImportedSource = vi.fn(() => void order.push('source'))
    const targetSession = makeSession({
      clearStorageData: vi.fn(async () => void order.push('clearStorageData')),
      clearData: vi.fn(async () => void order.push('clearData'))
    })
    await resetBrowserProfilePartition({
      targetSession,
      partition: 'persist:orca-browser',
      clearPendingCookieImport: vi.fn(() => void order.push('staged')),
      clearImportedSource
    })
    expect(clearImportedSource).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['source', 'staged', 'clearStorageData', 'clearData'])
  })

  it('reloads every live context in the partition after clearing', async () => {
    const order: string[] = []
    const targetSession = makeSession({
      clearData: vi.fn(async () => void order.push('clearData'))
    })
    const other = makeSession()
    const mine = makeContents(targetSession, { onReload: () => void order.push('mine') })
    const popup = makeContents(targetSession, { onReload: () => void order.push('popup') })
    const offscreen = makeContents(targetSession, { onReload: () => void order.push('offscreen') })
    const foreign = makeContents(other)
    const dead = makeContents(targetSession, { destroyed: true })
    getAllWebContentsMock.mockReturnValue([mine, popup, offscreen, foreign, dead])

    await resetBrowserProfilePartition({
      targetSession,
      partition: 'persist:orca-browser',
      clearPendingCookieImport: vi.fn(),
      clearImportedSource: vi.fn()
    })

    expect(mine.reload).toHaveBeenCalledTimes(1)
    expect(popup.reload).toHaveBeenCalledTimes(1)
    expect(offscreen.reload).toHaveBeenCalledTimes(1)
    expect(foreign.reload).not.toHaveBeenCalled()
    expect(dead.reload).not.toHaveBeenCalled()
    expect(order).toEqual(['clearData', 'mine', 'popup', 'offscreen'])
  })

  it('selects contexts by session identity so popups and offscreen guests are included', () => {
    const targetSession = makeSession()
    const other = makeSession()
    const a = makeContents(targetSession)
    const b = makeContents(other)
    getAllWebContentsMock.mockReturnValue([a, b])
    expect(findPartitionWebContents(targetSession)).toEqual([a])
  })

  it('survives a context that dies mid-reset', async () => {
    const targetSession = makeSession()
    const exploding = {
      session: targetSession,
      isDestroyed: () => false,
      reload: vi.fn(() => {
        throw new Error('destroyed')
      })
    }
    const healthy = makeContents(targetSession)
    getAllWebContentsMock.mockReturnValue([exploding, healthy])
    await expect(
      resetBrowserProfilePartition({
        targetSession,
        partition: 'persist:orca-browser',
        clearPendingCookieImport: vi.fn(),
        clearImportedSource: vi.fn()
      })
    ).resolves.toBeUndefined()
    expect(healthy.reload).toHaveBeenCalledTimes(1)
  })

  it('reloads live contexts after a partially failed clear', async () => {
    const targetSession = makeSession({
      clearData: vi.fn(async () => {
        throw new Error('clear failed')
      })
    })
    const live = makeContents(targetSession)
    getAllWebContentsMock.mockReturnValue([live])

    await expect(
      resetBrowserProfilePartition({
        targetSession,
        partition: 'persist:orca-browser',
        clearPendingCookieImport: vi.fn(),
        clearImportedSource: vi.fn()
      })
    ).rejects.toThrow('clear failed')
    expect(live.reload).toHaveBeenCalledTimes(1)
  })

  it('waits for the session mutation lock and releases it after failure', async () => {
    const targetSession = makeSession({
      clearData: vi.fn(async () => {
        throw new Error('clear failed')
      })
    })
    const clearImportedSource = vi.fn()
    const releaseImport = await acquireCookieMutationLock(targetSession)
    const reset = resetBrowserProfilePartition({
      targetSession,
      partition: 'persist:orca-browser',
      clearPendingCookieImport: vi.fn(),
      clearImportedSource
    })

    await Promise.resolve()
    expect(clearImportedSource).not.toHaveBeenCalled()
    releaseImport()
    await expect(reset).rejects.toThrow('clear failed')
    await expect(withCookieMutationLock(targetSession, async () => 'released')).resolves.toBe(
      'released'
    )
  })
})
