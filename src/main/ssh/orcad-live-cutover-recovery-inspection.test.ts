import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { createManagedOrcadSshOwner } from '../../shared/managed-orcad-ssh-owner'
import {
  parseOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../shared/orcad-migration-source-cutover'
import { terminalLayoutAdmissionFixture } from '../persistence/migrating-orcad-catalog/orcad-terminal-layout-admission-test-fixture'
import { OrcadLiveCutoverIntentStore } from './orcad-live-cutover-intent-store'
import { inspectOrcadLiveCutoverRecovery } from './orcad-live-cutover-recovery-inspection'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-live-inspection-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
function fixture(persist = true) {
  const { manifest, bindings } = terminalLayoutAdmissionFixture('folder')
  const record = parseOrcadMigrationSourceCutover({
    version: 2,
    phase: 'source-fenced',
    destinationEnvironmentId: 'environment',
    manifest,
    liveTerminalBindings: bindings,
    startedAt: manifest.createdAt,
    updatedAt: manifest.createdAt
  })
  if (persist) {
    new OrcadLiveCutoverIntentStore(root).persist(record)
  }
  const target: SshTarget = {
    id: manifest.source.sshTargetId,
    generation: manifest.source.sshTargetGeneration!,
    label: manifest.source.targetLabel,
    host: 'host',
    username: 'user',
    port: 22
  }
  const journals: OrcadMigrationSourceCutover[] = []
  const store = {
    getSshTarget: vi.fn(() => target),
    listOrcadMigrationSourceCutovers: vi.fn(() => structuredClone(journals))
  }
  return { record, target, journals, store }
}

it('distinguishes intent-only, fenced missing-phase and retained journal without changing evidence', () => {
  const f = fixture()
  expect(inspectOrcadLiveCutoverRecovery(root, f.store)[0].state).toBe('intent-only')
  f.target.owner = createManagedOrcadSshOwner('environment')
  expect(inspectOrcadLiveCutoverRecovery(root, f.store)[0]).toMatchObject({
    state: 'phase-unverifiable',
    journal: undefined
  })
  f.journals.push(
    parseOrcadMigrationSourceCutover({
      ...f.record,
      phase: 'destination-staged',
      stagedAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:00.000Z'
    })
  )
  const before = structuredClone(f.journals)
  expect(inspectOrcadLiveCutoverRecovery(root, f.store)[0].state).toBe('journal-retained')
  expect(f.journals).toEqual(before)
  f.journals.length = 0
  expect(inspectOrcadLiveCutoverRecovery(root, f.store)[0].state).toBe('phase-unverifiable')
})

it('retains local participation enrollment while comparing an unchanged journal projection', () => {
  const f = fixture(false)
  new OrcadLiveCutoverIntentStore(root).persist({ ...f.record, profileParticipationRequired: true })
  f.target.owner = createManagedOrcadSshOwner('environment')
  f.journals.push(f.record)
  const inspected = inspectOrcadLiveCutoverRecovery(root, f.store)[0]
  expect(inspected.intent.profileParticipationRequired).toBe(true)
  expect(inspected.journal).toEqual(f.record)
  expect(inspected.journal).not.toHaveProperty('profileParticipationRequired')
  expect(() => new OrcadLiveCutoverIntentStore(root).persist(f.record)).toThrow('conflict')
})

it.each(['owner', 'generation', 'journal', 'missing-fence', 'missing-intent'] as const)(
  'refuses %s conflict',
  (change) => {
    const f = fixture(change !== 'missing-intent')
    f.target.owner = createManagedOrcadSshOwner('environment')
    f.journals.push(f.record)
    if (change === 'owner') {
      f.target.owner = createManagedOrcadSshOwner('other')
    } else if (change === 'generation') {
      f.target.generation!++
    } else if (change === 'journal') {
      f.journals[0].destinationEnvironmentId = 'other'
    } else if (change === 'missing-fence') {
      delete f.target.owner
    }
    expect(() => inspectOrcadLiveCutoverRecovery(root, f.store)).toThrow()
  }
)
