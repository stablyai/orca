import { expect, it } from 'vitest'
import { digestPtyOwnershipInitialModelSnapshot } from './pty-ownership-transfer-initial-model-digest'

const identity = {
  bridgeId: 'bridge',
  terminalId: 'pty',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'host'
}
const model = {
  version: 1,
  identity,
  throughSeq: 20,
  modelSequenceEnd: 100,
  modelData: 'retained',
  cols: 80,
  rows: 24,
  restoreMetadata: {
    version: 1,
    pendingEscapeTailAnsi: '\x1b[',
    oscLinks: [{ row: 0, startCol: 0, endCol: 5, uri: 'https://example.com' }]
  }
}
const digest = (value: unknown) => digestPtyOwnershipInitialModelSnapshot(value, identity, 20)

it('hashes equivalent validated snapshots independently of object key order', () => {
  const reordered = {
    ...model,
    identity: Object.fromEntries(Object.entries(identity).toReversed()),
    restoreMetadata: {
      ...model.restoreMetadata,
      oscLinks: model.restoreMetadata.oscLinks.map((link) =>
        Object.fromEntries(Object.entries(link).toReversed())
      )
    }
  }
  expect(digest(reordered)).toBe(digest(model))
  expect(digest({ ...model, futureField: true })).toBe(digest(model))
  expect(digest(model)).toMatch(/^[a-f0-9]{64}$/)
})

it.each([
  { modelData: 'different' },
  { modelSequenceEnd: 101 },
  { cols: 81 },
  { rows: 25 },
  { restoreMetadata: { ...model.restoreMetadata, pendingEscapeTailAnsi: '\x1b]' } },
  { restoreMetadata: { ...model.restoreMetadata, oscLinks: [] } }
])('binds all model and restore state: %j', (patch) => {
  expect(digest({ ...model, ...patch })).not.toBe(digest(model))
})

it.each([
  { throughSeq: 21 },
  { identity: { ...identity, ownerLease: 'other' } },
  { restoreMetadata: undefined }
])('refuses invalid snapshot evidence before hashing: %j', (patch) => {
  expect(() => digest({ ...model, ...patch })).toThrow()
})
