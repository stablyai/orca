import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyProductionCapacityDirector
} from './classify-relay-production-capacity-director.mjs'

const capacityServiceAccount =
  'orca-cloud-gha-relay-cap@onorca-cloud.iam.gserviceaccount.com'
const capacityCellIds = ['production-gce-c25', 'production-gce-c26']
const baseCells = [
  { id: 'production-gce-c17', connectionHardCap: 600, connectionUnobservedBound: 60 },
  { id: 'production-gce-c25', connectionHardCap: 1000, connectionUnobservedBound: 60 },
  { id: 'production-gce-c26', connectionHardCap: 1000, connectionUnobservedBound: 60 }
]
const mixedCells = [
  baseCells[0],
  { ...baseCells[1], connectionHardCap: 600 },
  baseCells[2]
]

function state(overrides = {}) {
  return {
    baseCells,
    currentCells: mixedCells,
    capacityCellIds,
    targetCellId: 'production-gce-c25',
    targetHardCap: 1000,
    currentCapacityServiceAccount: capacityServiceAccount,
    ...overrides
  }
}

test('classifies one target while preserving completed rollout cells', () => {
  assert.deepEqual(
    classifyProductionCapacityDirector(state(), capacityServiceAccount),
    {
      topologyPhase: 'predecessor',
      directorReady: false,
      desiredCells: baseCells
    }
  )
})

test('skips deployment only for exact topology and identity', () => {
  assert.deepEqual(
    classifyProductionCapacityDirector(state({ currentCells: baseCells }), capacityServiceAccount),
    { topologyPhase: 'desired', directorReady: true, desiredCells: baseCells }
  )
  assert.deepEqual(
    classifyProductionCapacityDirector(state({
      currentCells: baseCells,
      targetHardCap: 600
    }), capacityServiceAccount),
    {
      topologyPhase: 'predecessor',
      directorReady: false,
      desiredCells: mixedCells
    }
  )
})

test('rejects an unknown topology or capacity identity', () => {
  assert.throws(
    () => classifyProductionCapacityDirector(state({
      currentCells: [baseCells[0], { ...baseCells[1], connectionHardCap: 700 }, baseCells[2]]
    }), capacityServiceAccount),
    /rollout state is invalid/
  )
  assert.throws(
    () => classifyProductionCapacityDirector(state({
      currentCapacityServiceAccount: 'unexpected@onorca-cloud.iam.gserviceaccount.com'
    }), capacityServiceAccount),
    /unexpected capacity identity/
  )
  assert.throws(
    () => classifyProductionCapacityDirector(state({
      currentCells: [{ ...baseCells[0], connectionHardCap: 1000 }, mixedCells[1], mixedCells[2]]
    }), capacityServiceAccount),
    /outside the capacity rollout/
  )
  assert.throws(
    () => classifyProductionCapacityDirector(state({
      currentCells: [baseCells[0], { ...mixedCells[1], url: 'https://wrong.invalid' }, baseCells[2]]
    }), capacityServiceAccount),
    /outside the reviewed capacity envelope/
  )
  assert.throws(
    () => classifyProductionCapacityDirector(state({
      targetCellId: 'production-gce-c17'
    }), capacityServiceAccount),
    /transition input is invalid/
  )
})
