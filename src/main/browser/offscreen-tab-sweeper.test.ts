import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveServeBrowserIdleSleepSecondsMock } = vi.hoisted(() => ({
  resolveServeBrowserIdleSleepSecondsMock: vi.fn(() => 600)
}))

vi.mock('./serve-browser-settings', () => ({
  resolveServeBrowserIdleSleepSeconds: resolveServeBrowserIdleSleepSecondsMock
}))

import { OffscreenTabSweeper } from './offscreen-tab-sweeper'

type Page = { lastActivityAt: number; hasActiveLease: boolean }

function makePorts(pages: Map<string, Page>, slept: string[] = []) {
  return {
    getInventory: vi.fn(() => {
      const inventory = new Map<
        string,
        { webContentsId: number; lastActivityAt: number; hasActiveLease: boolean }
      >()
      for (const [pageId, page] of pages) {
        inventory.set(pageId, { webContentsId: 1, ...page })
      }
      return inventory
    }),
    sleepPage: vi.fn(async (pageId: string) => {
      slept.push(pageId)
    })
  }
}

describe('OffscreenTabSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resolveServeBrowserIdleSleepSecondsMock.mockReturnValue(600)
  })

  it('sleeps pages idle past the configured seconds, oldest first', () => {
    const pages = new Map<string, Page>([
      ['old', { lastActivityAt: 0, hasActiveLease: false }],
      ['recent', { lastActivityAt: Date.now() - 1_000, hasActiveLease: false }],
      ['boundary', { lastActivityAt: Date.now() - 600_000, hasActiveLease: false }]
    ])
    const slept: string[] = []
    const ports = makePorts(pages, slept)
    const sweeper = new OffscreenTabSweeper(ports)

    const result = sweeper.sweep()

    // boundary is exactly at the cutoff (activity <= now - 600s) and sleeps; recent does not.
    expect(result).toEqual(['old', 'boundary'])
    expect(slept).toEqual(['old', 'boundary'])
  })

  it('skips pages holding an active paint lease', () => {
    const pages = new Map<string, Page>([
      ['leased', { lastActivityAt: 0, hasActiveLease: true }],
      ['idle', { lastActivityAt: 0, hasActiveLease: false }]
    ])
    const slept: string[] = []
    const sweeper = new OffscreenTabSweeper(makePorts(pages, slept))

    sweeper.sweep()

    expect(slept).toEqual(['idle'])
  })

  it('does nothing when the setting is 0 (never sleep)', () => {
    resolveServeBrowserIdleSleepSecondsMock.mockReturnValue(0)
    const pages = new Map<string, Page>([['idle', { lastActivityAt: 0, hasActiveLease: false }]])
    const slept: string[] = []
    const sweeper = new OffscreenTabSweeper(makePorts(pages, slept))

    sweeper.sweep()

    expect(slept).toEqual([])
    sweeper.start()
    vi.advanceTimersByTime(120_000)
    expect(slept).toEqual([])
    sweeper.stop()
  })

  it('re-reads the setting each sweep so live changes apply', () => {
    const pages = new Map<string, Page>([['idle', { lastActivityAt: 0, hasActiveLease: false }]])
    const slept: string[] = []
    const sweeper = new OffscreenTabSweeper(makePorts(pages, slept))

    resolveServeBrowserIdleSleepSecondsMock.mockReturnValue(0)
    expect(sweeper.sweep()).toEqual([])

    resolveServeBrowserIdleSleepSecondsMock.mockReturnValue(600)
    sweeper.sweep()
    expect(slept).toEqual(['idle'])
  })

  it('runs periodically once started and stops on stop()', () => {
    const pages = new Map<string, Page>([['idle', { lastActivityAt: 0, hasActiveLease: false }]])
    const slept: string[] = []
    const ports = makePorts(pages, slept)
    const sweeper = new OffscreenTabSweeper(ports)

    sweeper.start()
    vi.advanceTimersByTime(60_000)
    expect(slept).toEqual(['idle'])

    sweeper.stop()
    vi.advanceTimersByTime(120_000)
    expect(slept).toEqual(['idle'])
  })

  it('does not stack intervals when started repeatedly', () => {
    const ports = makePorts(new Map())
    const sweeper = new OffscreenTabSweeper(ports)
    sweeper.start()
    sweeper.start()
    sweeper.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
