import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createStore,
  getRuntimeCodexHomePath,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'
import { getCodexSessionBackfillDate } from '../codex/codex-session-backfill-scan-dates'
import type { CodexSessionBackfillDate } from '../codex/codex-session-backfill-types'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const CUSTOM_HISTORY_HOME = 'C:\\Users\\Me\\.codex'

function getMarkerPath(): string {
  return join(testState.userDataDir, 'codex-session-backfill', 'backfill-complete.json')
}

function writeBaselineMarker(systemCodexHomePath: string, needsFullScan = false): void {
  mkdirSync(join(testState.userDataDir, 'codex-session-backfill'), { recursive: true })
  writeFileSync(
    getMarkerPath(),
    `${JSON.stringify({
      version: 4,
      systemSessionsRoot: join(systemCodexHomePath, 'sessions'),
      coverage: 'full',
      baselineScannedFiles: 5,
      pendingScanDates: [],
      needsFullScan,
      summary: { scannedFiles: 5 }
    })}\n`,
    'utf-8'
  )
}

function readPendingScanDates(): unknown {
  return (JSON.parse(readFileSync(getMarkerPath(), 'utf-8')) as { pendingScanDates?: unknown })
    .pendingScanDates
}

describe('host system default session migration pass preparation', () => {
  beforeEach(() => {
    setupRuntimeHomeTest()
  })

  afterEach(() => {
    teardownRuntimeHomeTest()
  })

  it('records the launch date and keeps the baseline instead of deleting it', async () => {
    writeBaselineMarker(CUSTOM_HISTORY_HOME)
    const store = createStore(
      createSettings({ codexSessionSourceHome: { host: CUSTOM_HISTORY_HOME, wsl: {} } })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareHostSystemDefaultSessionMigrationPass()).toBe(false)

    expect(readPendingScanDates()).toEqual([getCodexSessionBackfillDate()])
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({ coverage: 'full' })
  })

  it('persists every date a scheduled pass reports so a force-quit stays bounded', async () => {
    writeBaselineMarker(CUSTOM_HISTORY_HOME)
    const store = createStore(
      createSettings({ codexSessionSourceHome: { host: CUSTOM_HISTORY_HOME, wsl: {} } })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    const spannedDates: CodexSessionBackfillDate[] = [
      ['2026', '08', '05'],
      ['2026', '08', '06']
    ]

    service.prepareHostSystemDefaultSessionMigrationPass(spannedDates)

    expect(readPendingScanDates()).toEqual(spannedDates)
  })

  it('does not demand a full scan when the same history home is spelled differently', async () => {
    writeBaselineMarker(CUSTOM_HISTORY_HOME)
    const store = createStore(
      createSettings({ codexSessionSourceHome: { host: CUSTOM_HISTORY_HOME, wsl: {} } })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      false
    )

    store.updateSettings({
      codexSessionSourceHome: { host: 'c:/users/me/.codex', wsl: {} }
    })

    expect(service.prepareHostSystemDefaultSessionMigrationPass()).toBe(false)
  })

  it('carries a full-scan demand persisted by an earlier launch into this pass', async () => {
    writeBaselineMarker(CUSTOM_HISTORY_HOME, true)
    const store = createStore(
      createSettings({ codexSessionSourceHome: { host: CUSTOM_HISTORY_HOME, wsl: {} } })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)

    expect(service.prepareHostSystemDefaultSessionMigrationPass()).toBe(true)

    // Recording this launch must not erase the demand the marker still carries.
    expect(JSON.parse(readFileSync(getMarkerPath(), 'utf-8'))).toMatchObject({
      needsFullScan: true
    })
  })

  it('still demands a full scan when the history home really moves', async () => {
    writeBaselineMarker(CUSTOM_HISTORY_HOME)
    const store = createStore(
      createSettings({ codexSessionSourceHome: { host: CUSTOM_HISTORY_HOME, wsl: {} } })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    const service = new CodexRuntimeHomeService(store as never)
    expect(service.beginHostSystemDefaultSessionMigrationLaunch(getRuntimeCodexHomePath())).toBe(
      false
    )

    store.updateSettings({
      codexSessionSourceHome: { host: 'C:\\Users\\Me\\moved-codex', wsl: {} }
    })

    expect(service.prepareHostSystemDefaultSessionMigrationPass()).toBe(true)
  })
})
