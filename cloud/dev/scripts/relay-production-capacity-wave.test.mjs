import assert from 'node:assert/strict'
import test from 'node:test'
import {
  capacityWavePreflightState,
  capacityWaveResumePreflightState,
  parseCapacityWave
} from './relay-production-capacity-wave.mjs'

const wave = [
  'production-gce-c22',
  'production-gce-c21',
  'production-gce-c20',
  'production-gce-c19'
]

function evidence(overrides = {}) {
  return {
    schemaVersion: 4,
    environment: 'production',
    preDrainDryRun: true,
    migrationPolicy: 'capacity-transition',
    recoverySourceCellId: null,
    capacityCellId: wave[0],
    expectedSelector: {
      generation: 39,
      membership: {
        existingOnly: ['production-gce-c1'],
        migrationOnly: ['production-gce-c17', 'production-gce-c18'],
        general: [...wave, 'production-gce-c23']
      }
    },
    sampleCount: 16,
    frozenAt: null,
    completedAt: '2026-08-11T21:00:00.000Z',
    ...overrides
  }
}

test('accepts only exact confirmed waves of two to four approved cells', () => {
  for (const cells of [wave.slice(0, 2), wave]) {
    const value = cells.join(',')
    assert.deepEqual(
      parseCapacityWave(value, `RAISE_SELECTED_WAVE_TO_1000 ${value}`),
      cells
    )
  }
  for (const [cells, confirmation] of [
    [[wave[0]], `RAISE_SELECTED_WAVE_TO_1000 ${wave[0]}`],
    [[...wave, 'production-gce-c16'], `RAISE_SELECTED_WAVE_TO_1000 ${wave.join(',')}`],
    [[wave[0], wave[0]], `RAISE_SELECTED_WAVE_TO_1000 ${wave[0]},${wave[0]}`],
    [[wave[0], 'production-gce-c17'], `RAISE_SELECTED_WAVE_TO_1000 ${wave[0]},production-gce-c17`],
    [[wave[0], ` ${wave[1]}`], `RAISE_SELECTED_WAVE_TO_1000 ${wave[0]}, ${wave[1]}`],
    [wave, 'RAISE_SELECTED_WAVE_TO_1000 production-gce-c22']
  ]) {
    assert.throws(() => parseCapacityWave(cells.join(','), confirmation))
  }
})

test('derives each continuation preflight from the sealed selector generation', () => {
  for (const [index, cell] of wave.entries()) {
    const state = capacityWavePreflightState(
      evidence(),
      wave.join(','),
      String(index),
      cell
    )
    assert.equal(state.expectedSelector.generation, 39 + index * 2)
    assert.equal(state.capacityCellId, cell)
    assert.deepEqual(state.expectedSelector.membership, evidence().expectedSelector.membership)
  }
})

test('derives an exact isolated-cell resume state from sealed wave evidence', () => {
  const state = capacityWaveResumePreflightState(
    evidence(),
    wave.join(','),
    wave[3]
  )
  assert.equal(state.expectedSelector.generation, 46)
  assert.equal(state.capacityCellId, wave[0])
  assert.deepEqual(state.expectedSelector.membership, {
    existingOnly: ['production-gce-c1'],
    migrationOnly: ['production-gce-c17', 'production-gce-c18', wave[3]].sort(),
    general: [wave[0], wave[1], wave[2], 'production-gce-c23']
  })
})

test('resume rejects a target outside the exact sealed wave', () => {
  assert.throws(
    () => capacityWaveResumePreflightState(
      evidence(),
      wave.join(','),
      'production-gce-c16'
    ),
    /does not match/
  )
})

test('resume rebinds first-cell evidence to another general wave cell', () => {
  const state = capacityWaveResumePreflightState(
    evidence(),
    wave.join(','),
    wave[0]
  )
  assert.equal(state.capacityCellId, wave[1])
  assert.equal(state.expectedSelector.generation, 40)
  assert.ok(state.expectedSelector.membership.migrationOnly.includes(wave[0]))
  assert.ok(state.expectedSelector.membership.general.includes(wave[1]))
})

test('rejects reordered, incomplete, frozen, or mismatched wave evidence', () => {
  const calls = [
    () => capacityWavePreflightState(evidence(), wave.join(','), '1', wave[0]),
    () => capacityWavePreflightState(evidence({ capacityCellId: wave[1] }), wave.join(','), '0', wave[0]),
    () => capacityWavePreflightState(evidence({ sampleCount: 15 }), wave.join(','), '0', wave[0]),
    () => capacityWavePreflightState(evidence({ frozenAt: '2026-08-11T20:59:00.000Z' }), wave.join(','), '0', wave[0]),
    () => capacityWavePreflightState(evidence({ completedAt: null }), wave.join(','), '0', wave[0]),
    () => capacityWavePreflightState(evidence({
      expectedSelector: {
        ...evidence().expectedSelector,
        membership: {
          ...evidence().expectedSelector.membership,
          general: wave.slice(1)
        }
      }
    }), wave.join(','), '0', wave[0])
  ]
  for (const call of calls) assert.throws(call, /does not match/)
})
