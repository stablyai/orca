import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { assertManualSshTargetDestructionAllowed } from './ssh-target-destruction-admission'
import { OrcadOutgoingPreparationStore } from '../ssh/orcad-outgoing-preparation-store'
import { createOrcadModelImportFixture } from '../orcad/orcad-model-import-test-fixture'
import {
  identity,
  preparation
} from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'

const state = vi.hoisted(() => ({ directory: '', target: vi.fn() }))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: new Map() }))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => state.directory
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ getTarget: state.target })
}))

beforeEach(() => {
  state.directory = mkdtempSync(join(tmpdir(), 'orcad-destruction-admission-'))
  state.target.mockReturnValue({ id: 'source' })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state.directory, { recursive: true, force: true })
})

function persistPreparation() {
  const model = createOrcadModelImportFixture(state.directory)
  return new OrcadOutgoingPreparationStore(state.directory).persist({
    version: 1,
    kind: 'preparation',
    identity,
    destinationEnvironmentId: 'destination',
    sourceSshTargetId: 'source',
    sourceSshTargetGeneration: 1,
    source: model.store.loadDelegatedSource(identity),
    surfaceBinding: preparation.surfacePublication.surfaceBinding
  })
}

it('permits ordinary targets when no preparation was recorded', () => {
  expect(() => assertManualSshTargetDestructionAllowed('source')).not.toThrow()
})

it('rediscovers persisted preparation on every call without needing an active connection', () => {
  assertManualSshTargetDestructionAllowed('source')
  persistPreparation()
  expect(() => assertManualSshTargetDestructionAllowed('source')).toThrow('reconciliation_required')
  state.target.mockReturnValue(undefined)
  expect(() => assertManualSshTargetDestructionAllowed('source')).toThrow('reconciliation_required')
  expect(() => assertManualSshTargetDestructionAllowed('other')).not.toThrow()
})

it('does not discard old preparation when the target generation changes', () => {
  persistPreparation()
  state.target.mockReturnValue({ id: 'source', generation: 2 })
  expect(() => assertManualSshTargetDestructionAllowed('source')).toThrow('reconciliation_required')
})

it.each(['unreadable', 'malformed'])(
  'propagates %s discovery rather than allowing destruction',
  (reason) => {
    vi.spyOn(OrcadOutgoingPreparationStore.prototype, 'list').mockImplementation(() => {
      throw new Error(reason)
    })
    expect(() => assertManualSshTargetDestructionAllowed('source')).toThrow(reason)
  }
)
