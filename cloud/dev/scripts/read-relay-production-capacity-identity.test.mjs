import assert from 'node:assert/strict'
import test from 'node:test'
import { readProductionCapacityIdentity } from './read-relay-production-capacity-identity.mjs'

function revision(env) {
  return { spec: { containers: [{ env }] } }
}

test('reads absent, exact, and foreign literal capacity identities', () => {
  assert.equal(readProductionCapacityIdentity(revision([])), null)
  assert.equal(
    readProductionCapacityIdentity(revision([
      { name: 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT', value: 'capacity@example.test' }
    ])),
    'capacity@example.test'
  )
  assert.equal(
    readProductionCapacityIdentity(revision([
      { name: 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT', value: 'foreign@example.test' }
    ])),
    'foreign@example.test'
  )
})

test('rejects malformed or duplicate capacity identity entries', () => {
  for (const entry of [
    { name: 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT', value: null },
    { name: 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT', value: '' },
    { name: 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT', valueSource: { secretKeyRef: {} } }
  ]) {
    assert.throws(
      () => readProductionCapacityIdentity(revision([entry])),
      /not a literal string/
    )
  }
  assert.throws(
    () => readProductionCapacityIdentity(revision([
      { name: 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT', value: 'one@example.test' },
      { name: 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT', value: 'two@example.test' }
    ])),
    /duplicate capacity identity/
  )
  assert.throws(() => readProductionCapacityIdentity({}), /environment is missing/)
})
