import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createRegionObservationEvidence,
  verifyRegionObservationEvidence
} from './relay-region-observation-evidence.mjs'

const now = Date.parse('2026-08-14T12:00:00Z')
const bindings = {
  commitSha: 'a'.repeat(40),
  directorImageDigest: `sha256:${'b'.repeat(64)}`,
  selectorGeneration: 11,
  controlGeneration: 4
}

function entries() {
  return Array.from({ length: 24 }, (_, index) => ({
    timestamp: new Date(now - (index * 60 + 30) * 60_000).toISOString(),
    jsonPayload: {
      event: 'orca_relay_runtime_metrics',
      role: 'director',
      requestedRegionsDelta: { 'asia-east2': index === 0 ? 2 : 0 },
      selectedRegionsDelta: { 'asia-east2': index === 0 ? 1 : 0 },
      regionFallbacksDelta: { 'asia-east2': index === 0 ? 1 : 0 },
      unavailableRegionsDelta: {}
    }
  }))
}

test('seals all 24 hourly aggregate region buckets', () => {
  const sealed = createRegionObservationEvidence(entries(), bindings, now)
  assert.equal(sealed.evidence.hourlySampleCounts.length, 24)
  assert.equal(sealed.evidence.totals.requestedRegionsDelta['asia-east2'], 2)
  assert.equal(verifyRegionObservationEvidence(sealed, bindings).samples, 24)
})

test('rejects missing coverage, missing Asia activity, and changed bindings', () => {
  assert.throws(() => createRegionObservationEvidence(entries().slice(1), bindings, now), /missing hourly/)
  const noAsia = entries().map((entry) => ({
    ...entry,
    jsonPayload: {
      ...entry.jsonPayload,
      requestedRegionsDelta: {},
      selectedRegionsDelta: {}
    }
  }))
  assert.throws(() => createRegionObservationEvidence(noAsia, bindings, now), /no Asia/)
  const sealed = createRegionObservationEvidence(entries(), bindings, now)
  assert.throws(() => verifyRegionObservationEvidence(sealed, {
    ...bindings,
    commitSha: 'c'.repeat(40)
  }), /does not match/)
})
