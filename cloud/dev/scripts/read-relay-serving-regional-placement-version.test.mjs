import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyRelayServiceDescribeFailure,
  readRelayServingRegionalPlacementVersion
} from './read-relay-serving-regional-placement-version.mjs'

const input = {
  project: 'onorca-cloud',
  region: 'us-central1',
  service: 'orca-cloud-relay',
  bootstrap_version: '7'
}

function revision(version = '11') {
  return {
    spec: {
      containers: [{
        env: [{
          name: 'ORCA_RELAY_REGIONAL_PLACEMENT_ENABLED',
          valueSource: {
            secretKeyRef: {
              secret: 'orca-cloud-relay-regional-placement-enabled',
              version
            }
          }
        }]
      }]
    }
  }
}

// Why: `gcloud run revisions describe --format=json` emits the Knative v1 shape, where the
// secret lives in `name` and the version in `key`, and `name` may be the full resource path.
function v1Revision(name, key) {
  return {
    spec: {
      containers: [{
        env: [{
          name: 'ORCA_RELAY_REGIONAL_PLACEMENT_ENABLED',
          valueFrom: { secretKeyRef: { name, key } }
        }]
      }]
    }
  }
}

function serving() {
  return { status: { traffic: [{ revisionName: 'relay-serving', percent: 100 }] } }
}

test('reads the exact version from the sole traffic-serving revision', () => {
  const calls = []
  const result = readRelayServingRegionalPlacementVersion(input, {
    run: (args) => {
      calls.push(args)
      return calls.length === 1
        ? {
            status: {
              traffic: [
                { revisionName: 'relay-failed-latest', tag: 'candidate' },
                { revisionName: 'relay-serving', percent: 100 }
              ]
            }
          }
        : revision()
    }
  })

  assert.deepEqual(result, { version: '11' })
  assert.equal(calls[1][3], 'relay-serving')
})

test('reads the gcloud v1 secret reference shape by bare id and by full resource path', () => {
  for (const name of [
    'orca-cloud-relay-regional-placement-enabled',
    'projects/120364513935/secrets/orca-cloud-relay-regional-placement-enabled'
  ]) {
    assert.deepEqual(readRelayServingRegionalPlacementVersion(input, {
      run: (args) => args[1] === 'services' ? serving() : v1Revision(name, '1')
    }), { version: '1' })
  }
})

test('rejects a v1 reference that names another secret or a floating version', () => {
  assert.throws(() => readRelayServingRegionalPlacementVersion(input, {
    run: (args) => args[1] === 'services'
      ? serving()
      : v1Revision('projects/120364513935/secrets/some-other-secret', '1')
  }), /secret reference is invalid/)
  assert.throws(() => readRelayServingRegionalPlacementVersion(input, {
    run: (args) => args[1] === 'services'
      ? serving()
      : v1Revision('orca-cloud-relay-regional-placement-enabled', 'latest')
  }), /secret reference is invalid/)
})

test('falls back only when the service or setting is absent', () => {
  const notFound = new Error('not found')
  notFound.code = 'NOT_FOUND'
  assert.deepEqual(readRelayServingRegionalPlacementVersion(input, {
    run: () => { throw notFound }
  }), { version: '7' })
  assert.deepEqual(readRelayServingRegionalPlacementVersion(input, {
    run: (args) => args[1] === 'services'
      ? { status: { traffic: [{ revisionName: 'relay-serving', percent: 100 }] } }
      : { spec: { containers: [{ env: [] }] } }
  }), { version: '7' })
})

test('classifies real absent-service stderr without weakening revision failures', () => {
  const serviceArgs = ['run', 'services', 'describe', 'missing-service']
  const stderr = 'ERROR: (gcloud.run.services.describe) Cannot find service [missing-service]'
  assert.equal(classifyRelayServiceDescribeFailure(serviceArgs, stderr), 'NOT_FOUND')
  assert.equal(
    classifyRelayServiceDescribeFailure(['run', 'revisions', 'describe', 'missing-revision'], stderr),
    'GCLOUD_FAILED'
  )
  assert.equal(classifyRelayServiceDescribeFailure(serviceArgs, 'PERMISSION_DENIED'), 'GCLOUD_FAILED')
})

test('rejects ambiguous traffic, malformed references, and read failures', () => {
  assert.throws(() => readRelayServingRegionalPlacementVersion(input, {
    run: () => ({
      status: { traffic: [{ revisionName: 'a', percent: 50 }, { revisionName: 'b', percent: 50 }] }
    })
  }), /exactly one revision/)
  assert.throws(() => readRelayServingRegionalPlacementVersion(input, {
    run: (args) => args[1] === 'services'
      ? { status: { traffic: [{ revisionName: 'relay-serving', percent: 100 }] } }
      : revision('latest')
  }), /secret reference is invalid/)
  const denied = new Error('denied')
  denied.code = 'GCLOUD_FAILED'
  assert.throws(() => readRelayServingRegionalPlacementVersion(input, {
    run: () => { throw denied }
  }), denied)
})
