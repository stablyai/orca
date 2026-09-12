import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore, testState, writeDataFile } from '../../persistence-test-harness'
import { createManagedOrcadSshOwner } from '../../../shared/managed-orcad-ssh-owner'
import {
  normalizeOrcadMigrationSourceCutovers,
  parseOrcadMigrationSourceCutover
} from '../../../shared/orcad-migration-source-cutover'
import { terminalLayoutAdmissionFixture } from './orcad-terminal-layout-admission-test-fixture'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))

function fixture() {
  const { manifest, bindings } = terminalLayoutAdmissionFixture('folder')
  return {
    version: 2,
    destinationEnvironmentId: 'environment',
    manifest,
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
    phase: 'source-fenced',
    liveTerminalBindings: bindings
  }
}

it.each(['source-fenced', 'destination-staged'])(
  'retains exact live authority through %s journal normalization',
  (phase) => {
    const record = {
      ...fixture(),
      phase,
      ...(phase === 'destination-staged' ? { stagedAt: '2026-09-07T00:00:00.000Z' } : {})
    }
    expect(parseOrcadMigrationSourceCutover(record)).toEqual(record)
    expect(normalizeOrcadMigrationSourceCutovers(JSON.parse(JSON.stringify([record])))).toEqual([
      record
    ])
  }
)

it.each(['missing', 'legacy', 'duplicate', 'pane', 'destination'] as const)(
  'refuses %s live authority',
  (change) => {
    const record = structuredClone(fixture())
    if (change === 'missing') {
      Reflect.deleteProperty(record, 'liveTerminalBindings')
    } else if (change === 'legacy') {
      record.version = 1
    } else if (change === 'duplicate') {
      record.liveTerminalBindings = [record.liveTerminalBindings[0], record.liveTerminalBindings[0]]
    } else if (change === 'pane') {
      Object.assign(record.liveTerminalBindings[0].surfaceBinding, { tabId: 'other' })
    } else {
      Object.assign(record.liveTerminalBindings[1].identity, { destinationRuntimeId: 'other' })
    }
    expect(() => parseOrcadMigrationSourceCutover(record)).toThrow()
  }
)

it.each(['destination-committed', 'source-retired'])(
  'does not accept catalog-only evidence for live %s',
  (phase) => {
    expect(() => parseOrcadMigrationSourceCutover({ ...fixture(), phase })).toThrow(
      'completion_evidence_required'
    )
  }
)

it('retains the live journal and target fence on Store reload while legacy mutations refuse it', () => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-live-cutover-'))
  try {
    const record = fixture()
    const { state } = terminalLayoutAdmissionFixture('folder')
    state.orcadMigrationSourceCutovers = [parseOrcadMigrationSourceCutover(record)]
    state.sshTargets = [
      {
        id: record.manifest.source.sshTargetId,
        generation: record.manifest.source.sshTargetGeneration!,
        label: record.manifest.source.targetLabel,
        host: 'host',
        port: 22,
        username: 'user',
        owner: createManagedOrcadSshOwner(record.destinationEnvironmentId)
      }
    ]
    writeDataFile(state)
    const store = createStore()
    expect(store.getOrcadMigrationSourceCutover(record.manifest.migrationId)).toEqual(record)
    expect(() =>
      store.beginOrcadMigrationSourceCutover(record.manifest, record.destinationEnvironmentId)
    ).toThrow('live_cutover_coordinator_required')
    expect(() => store.retireOrcadMigrationSourceCatalog(record.manifest.migrationId)).toThrow(
      'live_cutover_coordinator_required'
    )
    expect(() =>
      store.releaseOrcadMigrationSourceCutover(record.manifest.migrationId, {
        kind: 'stage-method-unsupported'
      })
    ).toThrow('live_cutover_coordinator_required')
    store.flushOrThrow()
    expect(createStore().getOrcadMigrationSourceCutover(record.manifest.migrationId)).toEqual(
      record
    )
    expect(createStore().getSshTarget(record.manifest.source.sshTargetId)?.owner).toEqual(
      state.sshTargets[0].owner
    )
  } finally {
    rmSync(testState.dir, { recursive: true, force: true })
  }
})
