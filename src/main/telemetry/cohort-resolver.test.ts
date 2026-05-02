import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, readFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { GlobalSettings } from '../../shared/types'
import type { Store } from '../persistence'
import { initCohortResolver } from './cohort-resolver'

// ── File-backed Store fixtures ──────────────────────────────────────────
//
// These tests exercise `initCohortResolver` through the real `Store`, not a
// fake, for two reasons:
//   1. Case B's invariant is that the write reaches disk via `updateSettings`
//      + debounced save + `flush()` on shutdown — the in-memory shape alone
//      cannot prove that a force-quit between the resolver's write and the
//      next launch preserves the flag. Using the real store lets us call
//      `flush()` and re-load to simulate that exact sequence.
//   2. The cohort-resolver contract composes with `Store`'s `updateSettings`
//      deep-merge on the telemetry block (`persistence.ts:408-430`). A fake
//      that shallow-copies would mask sibling-field loss bugs.

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  }
}))

vi.mock('../git/repo', () => ({
  getGitUsername: vi.fn().mockReturnValue('testuser')
}))

async function createStore(): Promise<Store> {
  vi.resetModules()
  const { Store, initDataPath } = await import('../persistence')
  initDataPath()
  return new Store()
}

function dataFile(): string {
  return join(testState.dir, 'orca-data.json')
}

function writeDataFile(data: unknown): void {
  mkdirSync(testState.dir, { recursive: true })
  writeFileSync(dataFile(), JSON.stringify(data, null, 2), 'utf-8')
}

function readDataFile(): { settings?: { telemetry?: GlobalSettings['telemetry'] } } {
  return JSON.parse(readFileSync(dataFile(), 'utf-8'))
}

function telemetryOnDisk(): GlobalSettings['telemetry'] {
  return readDataFile().settings?.telemetry
}

const DAY_MS = 24 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * DAY_MS

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

// Data-file shape that seeds `Store.load()` with an existing-user cohort and
// a specified telemetry block. The migration's invariant check keeps this
// block intact so the resolver sees exactly what we wrote.
function existingUserWithTelemetry(
  telemetry: NonNullable<GlobalSettings['telemetry']>
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings: { telemetry },
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {}
  }
}

describe('initCohortResolver', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-cohort-resolver-test-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  // ── Case A — second-ask banner rendered in a prior session, terminal ──

  it('promotes optedIn to false when the second-ask banner was shown but never resolved (Case A)', async () => {
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: null,
        installId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        existedBeforeTelemetryRelease: true,
        firstBannerDismissedAt: isoDaysAgo(10),
        firstBannerSecondAskShown: true
      })
    )

    const store = await createStore()
    initCohortResolver(store)

    // In-memory state reflects the Case A promotion immediately.
    expect(store.getSettings().telemetry?.optedIn).toBe(false)
    // `firstBannerSecondAskShown` must be preserved — losing it would let the
    // next launch re-render the second-ask banner for a user we just counted
    // as opted-out.
    expect(store.getSettings().telemetry?.firstBannerSecondAskShown).toBe(true)
    // `installId` must survive (the deep-merge on `updateSettings` is doing
    // real work — a shallow replace here would have dropped it).
    expect(store.getSettings().telemetry?.installId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  })

  // ── Case B — ✕-dismiss > 7 days ago, second-ask not yet shown ─────────

  it('sets firstBannerSecondAskShown when ✕-dismissed > 7 days ago and not yet shown (Case B)', async () => {
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: null,
        installId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        existedBeforeTelemetryRelease: true,
        // 8 days ago — strictly outside the 7-day suppression window.
        firstBannerDismissedAt: isoDaysAgo(8)
      })
    )

    const store = await createStore()
    initCohortResolver(store)

    // The write is observable on the store before any debounce fires. Not
    // waiting on a timer here is load-bearing: the contract is that the
    // resolver's side effect is visible synchronously in the in-memory store.
    expect(store.getSettings().telemetry?.firstBannerSecondAskShown).toBe(true)
    // `optedIn` stays null — the second-ask banner is about to render; the
    // user still gets one more chance.
    expect(store.getSettings().telemetry?.optedIn).toBeNull()
  })

  it('does not set firstBannerSecondAskShown inside the 7-day suppression window', async () => {
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: null,
        installId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        existedBeforeTelemetryRelease: true,
        firstBannerDismissedAt: isoDaysAgo(3)
      })
    )

    const store = await createStore()
    initCohortResolver(store)

    expect(store.getSettings().telemetry?.firstBannerSecondAskShown).toBeUndefined()
    expect(store.getSettings().telemetry?.optedIn).toBeNull()
  })

  it('does not set firstBannerSecondAskShown exactly at the 7-day boundary', async () => {
    // Why: the resolver's comparison is `>=` on the elapsed ms, so an ISO
    // timestamp that is exactly 7 days - epsilon old should still be inside
    // the window. Using `< SEVEN_DAYS_MS` directly guards against off-by-one
    // flips in the comparison operator.
    const dismissedAt = new Date(Date.now() - (SEVEN_DAYS_MS - 1000)).toISOString()
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: null,
        installId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        existedBeforeTelemetryRelease: true,
        firstBannerDismissedAt: dismissedAt
      })
    )

    const store = await createStore()
    initCohortResolver(store)

    expect(store.getSettings().telemetry?.firstBannerSecondAskShown).toBeUndefined()
  })

  // ── Case B persistence — survives a simulated force-quit ──────────────

  it('persists firstBannerSecondAskShown across a flush + reload (simulates force-quit)', async () => {
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: null,
        installId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        existedBeforeTelemetryRelease: true,
        firstBannerDismissedAt: isoDaysAgo(30)
      })
    )

    const store = await createStore()
    initCohortResolver(store)
    // Force-quit sequence: `will-quit` calls `store.flush()` which writes
    // synchronously, bypassing the 300 ms debounce. If the resolver's write
    // didn't go through `updateSettings`, this flush would not see it and the
    // flag would be lost.
    store.flush()

    expect(existsSync(dataFile())).toBe(true)
    expect(telemetryOnDisk()?.firstBannerSecondAskShown).toBe(true)

    // Next launch sees the flag; Case A promotes to opted-out.
    const nextLaunch = await createStore()
    initCohortResolver(nextLaunch)
    expect(nextLaunch.getSettings().telemetry?.optedIn).toBe(false)
  })

  // ── No-op cases — cohorts / states the resolver must not touch ────────

  it('is a no-op when the user has already opted in', async () => {
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: true,
        installId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        existedBeforeTelemetryRelease: true
      })
    )

    const store = await createStore()
    const before = { ...store.getSettings().telemetry }
    initCohortResolver(store)
    expect(store.getSettings().telemetry).toEqual(before)
  })

  it('is a no-op when the user has already opted out', async () => {
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: false,
        installId: '00000000-0000-4000-8000-000000000000',
        existedBeforeTelemetryRelease: true
      })
    )

    const store = await createStore()
    const before = { ...store.getSettings().telemetry }
    initCohortResolver(store)
    expect(store.getSettings().telemetry).toEqual(before)
  })

  it('is a no-op for new-user cohort (existedBeforeTelemetryRelease=false)', async () => {
    // Fresh install — migration gave this user optedIn=true + new-user cohort.
    // The resolver's banner state machine is for existing users only.
    const store = await createStore()
    const before = { ...store.getSettings().telemetry }
    initCohortResolver(store)
    expect(store.getSettings().telemetry).toEqual(before)
  })

  // ── Toggle-inside-suppression window ──────────────────────────────────
  //
  // Documented test case: existing user ✕-dismisses, then flips the Privacy-
  // pane toggle ON inside the 7-day window. Simulated here by moving straight
  // from "dismissed 2 days ago, optedIn=null" to "dismissed 2 days ago,
  // optedIn=true" (what the toggle handler would persist), then running the
  // resolver to prove it does not corrupt state.

  it('leaves state alone when the user opts in inside the 7-day suppression window', async () => {
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: null,
        installId: '11111111-1111-4111-8111-111111111111',
        existedBeforeTelemetryRelease: true,
        firstBannerDismissedAt: isoDaysAgo(2)
      })
    )

    const store = await createStore()
    // User flips the Privacy pane toggle before the second-ask could ever
    // render — persists `optedIn=true`. `firstBannerDismissedAt` sticks
    // around (harmless; the resolver ignores it once optedIn is non-null).
    store.updateSettings({
      telemetry: { ...store.getSettings().telemetry!, optedIn: true }
    })

    initCohortResolver(store)

    const t = store.getSettings().telemetry!
    expect(t.optedIn).toBe(true)
    expect(t.firstBannerSecondAskShown).toBeUndefined()
    expect(t.firstBannerDismissedAt).toBeDefined()
  })

  // ── Malformed `firstBannerDismissedAt` ────────────────────────────────

  it('clears a malformed firstBannerDismissedAt instead of parking forever', async () => {
    // A non-ISO string parses to NaN; without handling, `Date.now() - NaN` is
    // NaN and the `>= SEVEN_DAYS_MS` comparison is always false, so Case B
    // never advances and the user stays stuck in banner-suppressed limbo.
    writeDataFile(
      existingUserWithTelemetry({
        optedIn: null,
        installId: '22222222-2222-4222-8222-222222222222',
        existedBeforeTelemetryRelease: true,
        firstBannerDismissedAt: 'not-a-date'
      })
    )

    const store = await createStore()
    initCohortResolver(store)

    const t = store.getSettings().telemetry!
    expect(t.firstBannerDismissedAt).toBeUndefined()
    expect(t.firstBannerSecondAskShown).toBeUndefined()
    expect(t.optedIn).toBeNull()
  })
})
