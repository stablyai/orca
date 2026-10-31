import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CdpCookie } from './browser-cdp-cookie'

type FakeSession = { partition: string; cookies: { flushStore: () => Promise<void> } }

const electron = vi.hoisted(() => {
  const jars = new Map<string, Record<string, unknown>[]>()
  const sessions = new Map<string, FakeSession>()
  const flushed: string[] = []
  const windows: { shown: boolean; destroyed: boolean }[] = []
  return { jars, sessions, flushed, windows }
})

function jar(partition: string): Record<string, unknown>[] {
  let cookies = electron.jars.get(partition)
  if (!cookies) {
    cookies = []
    electron.jars.set(partition, cookies)
  }
  return cookies
}

vi.mock('electron', () => {
  class BrowserWindow {
    private readonly state = { shown: false, destroyed: false }
    readonly webContents: unknown
    constructor(options: { show?: boolean; webPreferences: { session: FakeSession } }) {
      this.state.shown = options.show !== false
      electron.windows.push(this.state)
      const partition = options.webPreferences.session.partition
      this.webContents = {
        isDestroyed: () => false,
        debugger: {
          sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
            if (method === 'Network.getAllCookies') {
              return { cookies: jar(partition).map((cookie) => ({ ...cookie })) }
            }
            if (method === 'Network.setCookie') {
              if (String(params.value).includes('refused')) {
                return { success: false }
              }
              const url = new URL(String(params.url))
              jar(partition).push({
                name: params.name,
                value: params.value,
                domain: params.domain ?? url.hostname,
                path: params.path ?? '/',
                secure: params.secure,
                httpOnly: params.httpOnly,
                sameSite: params.sameSite,
                expires: params.expires ?? -1,
                session: params.expires === undefined,
                ...(params.partitionKey ? { partitionKey: params.partitionKey } : {})
              })
              return { success: true }
            }
            throw new Error(`unexpected CDP command ${method}`)
          }
        }
      }
    }
    async loadURL(): Promise<void> {}
    show(): void {
      this.state.shown = true
    }
    destroy(): void {
      this.state.destroyed = true
    }
  }
  return {
    BrowserWindow,
    webContents: { getAllWebContents: () => [] },
    session: {
      fromPartition: (partition: string): FakeSession => {
        let existing = electron.sessions.get(partition)
        if (!existing) {
          existing = {
            partition,
            cookies: {
              flushStore: async () => {
                electron.flushed.push(partition)
              }
            }
          }
          electron.sessions.set(partition, existing)
        }
        return existing
      }
    }
  }
})
vi.mock('./electron-debugger-lease', () => ({
  acquireElectronDebugger: () => ({ release: () => {} })
}))

import {
  copyBrowserPartitionCookies,
  flushBrowserPartitionCookies,
  planBrowserPartitionCookieCopy
} from './browser-partition-cookie-copy'

const SOURCE = 'persist:orca-browser-local'
const DESTINATION = `persist:orca-browser-v1-${'a'.repeat(64)}`

function cookie(overrides: Partial<CdpCookie> & { name: string }): CdpCookie {
  return {
    value: 'v',
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: false,
    session: false,
    expires: 2_000_000_000,
    sameSite: 'Lax',
    ...overrides
  }
}

beforeEach(() => {
  electron.jars.clear()
  electron.sessions.clear()
  electron.flushed.length = 0
  electron.windows.length = 0
})

describe('planBrowserPartitionCookieCopy', () => {
  it('copies httpOnly, partitioned and session-only cookies faithfully', () => {
    const plan = planBrowserPartitionCookieCopy(
      [
        cookie({ name: 'sid', httpOnly: true }),
        cookie({
          name: 'chips',
          partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false }
        }),
        cookie({ name: 'tab', session: true, expires: -1 }),
        cookie({ name: '__Host-id', domain: 'app.example.com' })
      ],
      []
    )

    expect(plan.counts.rejected).toBe(0)
    expect(plan.writes.map((write) => write.name)).toEqual(['sid', 'chips', 'tab', '__Host-id'])
    expect(plan.writes[0]).toMatchObject({ httpOnly: true, hostOnly: false })
    expect(plan.writes[1]?.partitionKey).toEqual({
      topLevelSite: 'https://top.example',
      hasCrossSiteAncestor: false
    })
    expect(plan.writes[2]?.expirationDate).toBeUndefined()
    expect(plan.writes[3]).toMatchObject({ hostOnly: true, url: 'https://app.example.com/' })
  })

  it('skips cookies the target already holds, source-bound sites, and opaque partitions', () => {
    const plan = planBrowserPartitionCookieCopy(
      [
        cookie({ name: 'sid', value: 'desktop' }),
        cookie({ name: 'SID', domain: '.google.com' }),
        cookie({ name: 'embed', partitionKeyOpaque: true }),
        cookie({ name: 'bad', domain: undefined }),
        cookie({
          name: 'chips',
          partitionKey: { topLevelSite: 'not a site', hasCrossSiteAncestor: false }
        })
      ],
      [cookie({ name: 'sid', value: 'host' })]
    )

    expect(plan.writes).toEqual([])
    expect(plan.counts).toMatchObject({
      skippedPresent: 1,
      skippedSourceBound: 1,
      skippedOpaquePartition: 1,
      rejected: 2
    })
  })

  it('keeps a partitioned and an unpartitioned cookie of the same name apart', () => {
    const plan = planBrowserPartitionCookieCopy(
      [
        cookie({
          name: 'sid',
          partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: false }
        })
      ],
      [cookie({ name: 'sid' })]
    )
    expect(plan.writes).toHaveLength(1)
  })
})

describe('copyBrowserPartitionCookies', () => {
  it('merges into the destination, never writes the source, and never shows a window', async () => {
    jar(SOURCE).push(
      cookie({ name: 'sid', httpOnly: true }),
      cookie({ name: 'tab', session: true, expires: -1 }),
      cookie({
        name: 'chips',
        partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
      }),
      cookie({ name: 'kept', value: 'desktop' }),
      cookie({ name: 'odd', value: 'refused' })
    )
    jar(DESTINATION).push(cookie({ name: 'kept', value: 'host' }))
    const sourceBefore = structuredClone(jar(SOURCE))

    const counts = await copyBrowserPartitionCookies(SOURCE, DESTINATION)

    expect(counts).toEqual({
      copied: 3,
      copiedHttpOnly: 1,
      copiedPartitioned: 1,
      copiedSessionOnly: 1,
      skippedPresent: 1,
      skippedSourceBound: 0,
      skippedOpaquePartition: 0,
      rejected: 1
    })
    expect(jar(SOURCE)).toEqual(sourceBefore)
    expect(jar(DESTINATION).find((entry) => entry.name === 'kept')?.value).toBe('host')
    expect(jar(DESTINATION).find((entry) => entry.name === 'chips')?.partitionKey).toEqual({
      topLevelSite: 'https://top.example',
      hasCrossSiteAncestor: true
    })
    expect(electron.windows.every((window) => !window.shown && window.destroyed)).toBe(true)
  })

  it('writes nothing twice when re-run after a crash', async () => {
    jar(SOURCE).push(cookie({ name: 'sid' }), cookie({ name: 'pref' }))
    await copyBrowserPartitionCookies(SOURCE, DESTINATION)

    const again = await copyBrowserPartitionCookies(SOURCE, DESTINATION)

    expect(again.copied).toBe(0)
    expect(again.skippedPresent).toBe(2)
    expect(jar(DESTINATION)).toHaveLength(2)
  })

  it('refuses to copy a partition into itself', async () => {
    await expect(copyBrowserPartitionCookies(SOURCE, SOURCE)).rejects.toThrow(
      'browser_partition_cookie_copy_same_partition'
    )
  })

  it('flushes the destination jar to disk', async () => {
    await flushBrowserPartitionCookies(DESTINATION)
    expect(electron.flushed).toEqual([DESTINATION])
  })
})
