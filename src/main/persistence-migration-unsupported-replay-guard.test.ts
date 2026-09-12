import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installFakeAppEnvironment } from '../../config/scripts/vitest-host-ports-setup'
import type { PersistedState } from '../shared/persisted-state-types'
import { Store } from './persistence/loading-store/store'

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

function writeProfile(dir: string, state: Record<string, unknown>): string {
  const dataFile = join(dir, 'orca-data.json')
  writeFileSync(dataFile, JSON.stringify(state), 'utf-8')
  return dataFile
}

/** A profile carrying restart-required rows an older build wrote. */
function profileWithMigrationUnsupportedRows(ptyId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    migrationUnsupportedPtyEntries: [
      {
        ptyId,
        tabId: 'tab-later',
        paneKey: 'tab-later:1',
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: 1
      }
    ]
  }
}

describe('Store migration-unsupported replay ownership', () => {
  let dirs: string[] = []

  beforeEach(() => {
    dirs = []
    installFakeAppEnvironment({ getPath: () => tmpdir() })
  })

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-migration-replay-guard-'))
    dirs.push(dir)
    return dir
  }

  // Why this is a tripwire and not a regression test: `Store` hands the
  // migration-unsupported singleton a listener that closes over this store, and never
  // detaches it, so a later store's constructor replays through the earlier store's
  // closure — the exact defect fixed for pane-key aliases in #17262. It is harmless
  // only because `normalizePersistedPaneIdentityState` retires these rows into aliases
  // and returns no entries to replay, leaving the loop unreachable. Re-emitting them
  // without first detaching (see the alias listener's clear) reddens this.
  it('does not write a later store’s migration-unsupported rows into an earlier store’s profile', () => {
    const earlierFile = writeProfile(makeDir(), { schemaVersion: 1 })
    const earlier = new Store({ dataFile: earlierFile })

    const laterFile = writeProfile(makeDir(), profileWithMigrationUnsupportedRows('pty-later'))
    new Store({ dataFile: laterFile })

    earlier.flush()
    const earlierState = JSON.parse(readFileSync(earlierFile, 'utf-8')) as PersistedState
    expect(earlierState.migrationUnsupportedPtyEntries ?? []).toEqual([])
  })
})
