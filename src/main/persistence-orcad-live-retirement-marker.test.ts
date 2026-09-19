import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore, testState, writeDataFile } from './persistence-test-harness'
import { inspectOrcadLiveRetirementRecovery } from './ssh/orcad-live-retirement-recovery-inspection'
import { withOrcadLiveSourceRecovery } from './ssh/orcad-live-source-recovery'

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-retirement-marker-'))
})
afterEach(() => {
  rmSync(testState.dir, { recursive: true, force: true })
})
const marker = {
  version: 1,
  migrationId: 'migration',
  recordSha256: 'a'.repeat(64),
  installedAt: '2026-09-07T00:00:00.000Z'
}

it('retains valid markers across actual profile loading and flushing', async () => {
  writeDataFile({ orcadLiveRetirementMarkers: [marker] })
  const store = createStore()
  expect(store.listOrcadLiveRetirementMarkers()).toEqual([marker])
  await store.flushPendingOrThrowAsync()
  expect(createStore().listOrcadLiveRetirementMarkers()).toEqual([marker])
  expect(() => inspectOrcadLiveRetirementRecovery(testState.dir, store)).toThrow(
    'recovery_record_missing'
  )
})

it('preserves corrupt marker evidence through loading instead of silently normalizing it away', async () => {
  writeDataFile({ orcadLiveRetirementMarkers: [{ ...marker, recordSha256: 'bad' }] })
  const store = createStore()
  expect(() => store.listOrcadLiveRetirementMarkers()).toThrow('marker_invalid')
  await store.flushPendingOrThrowAsync()
  expect(() => createStore().listOrcadLiveRetirementMarkers()).toThrow('marker_invalid')
})

it('refuses missing retirement evidence before trying to bind an incumbent source provider', async () => {
  writeDataFile({ orcadLiveRetirementMarkers: [marker] })
  let bound = false
  await expect(
    withOrcadLiveSourceRecovery(
      {
        profileDirectory: testState.dir,
        store: createStore(),
        migrationId: 'migration',
        signal: new AbortController().signal,
        runtime: {
          bindOutgoingSshPtyCatalogSurfaces: () => {
            bound = true
            throw new Error('unexpected bind')
          }
        }
      },
      async () => {}
    )
  ).rejects.toThrow('recovery_record_missing')
  expect(bound).toBe(false)
})
