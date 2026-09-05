import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  parseArguments,
  readStagingTopology,
  runStagingRelayPower
} from './power-staging-relay.mjs'

function topologyFile(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'staging-relay-power-'))
  const topology = {
    'staging-gce-c1': {
      mig_name: 'orca-cloud-staging-relay-gce-c1',
      zone: 'us-central1-b',
      origin: 'https://c1.relay-staging.onorca.dev',
      initially_enabled: true
    },
    'staging-gce-c2': {
      mig_name: 'orca-cloud-staging-relay-gce-c2',
      zone: 'us-central1-c',
      origin: 'https://c2.relay-staging.onorca.dev',
      initially_enabled: true
    },
    'staging-gce-c3': {
      mig_name: 'orca-cloud-staging-relay-gce-c3',
      zone: 'us-central1-a',
      origin: 'https://c3.relay-staging.onorca.dev',
      initially_enabled: false
    },
    'staging-gce-c4': {
      mig_name: 'orca-cloud-staging-relay-gce-c4',
      zone: 'asia-east2-a',
      origin: 'https://c4.relay-staging.onorca.dev',
      initially_enabled: false
    },
    ...overrides
  }
  const file = join(directory, 'topology.json')
  writeFileSync(file, JSON.stringify(topology))
  return file
}

function argumentConfig(file, mode, wakeCells = 'configured') {
  return parseArguments([
    '--mode',
    mode,
    '--wake-cells',
    wakeCells,
    '--topology-file',
    file
  ])
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function harness({
  sqlPolicy = 'ALWAYS',
  migSize = 1,
  observedRequests = 0,
  selectorGeneration = 0
} = {}) {
  const cells = new Map(
    ['staging-gce-c1', 'staging-gce-c2', 'staging-gce-c3', 'staging-gce-c4'].map((cellId, index) => [
      cellId,
      {
        enabled: index < 2,
        targetSize: migSize,
        observedRequests,
        initiallyEnabled: index < 2
      }
    ])
  )
  const revisions = new Map([
    ['orca-cloud-relay-staging', { active: 'relay-00001', latest: 'relay-00001', min: 1 }],
    ['orca-cloud-auth-staging', { active: 'auth-00001', latest: 'auth-00001', min: 1 }]
  ])
  const revisionMinimums = new Map([
    ['relay-00001', 1],
    ['auth-00001', 1]
  ])
  const commands = []
  const events = []
  let activationPolicy = sqlPolicy
  let clock = 0

  function cellForMig(name) {
    return [...cells.entries()].find(([, value], index) => {
      const suffix = `c${index + 1}`
      return name.endsWith(suffix) && value
    })
  }

  function commandJson(args) {
    if (args[0] === 'sql') return { settings: { activationPolicy } }
    if (args[0] === 'compute') {
      const entry = cellForMig(args[4])
      return { targetSize: entry[1].targetSize, status: { isStable: true } }
    }
    if (args[0] === 'run' && args[1] === 'services') {
      const state = revisions.get(args[3])
      return {
        status: {
          latestReadyRevisionName: state.latest,
          traffic: [{ percent: 100, revisionName: state.active }]
        }
      }
    }
    if (args[0] === 'run' && args[1] === 'revisions') {
      return {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': String(revisionMinimums.get(args[3]) ?? 0)
          }
        }
      }
    }
    throw new Error(`unexpected JSON command ${args.join(' ')}`)
  }

  function command(args) {
    commands.push(args)
    if (args[0] === 'sql') {
      activationPolicy = args.find((arg) => arg.startsWith('--activation-policy='))?.split('=')[1]
      return
    }
    if (args[0] === 'compute') {
      const entry = cellForMig(args[4])
      entry[1].targetSize = Number(args.find((arg) => arg.startsWith('--size='))?.split('=')[1])
      return
    }
    if (args[0] === 'run' && args[1] === 'services' && args[2] === 'update') {
      const state = revisions.get(args[3])
      state.latest = `${args[3]}-power`
      revisionMinimums.set(state.latest, 0)
      return
    }
    if (args[0] === 'run' && args[1] === 'services' && args[2] === 'update-traffic') {
      const state = revisions.get(args[3])
      state.active = state.latest
      return
    }
    throw new Error(`unexpected command ${args.join(' ')}`)
  }

  async function fetchImpl(url, options = {}) {
    const parsed = new URL(url)
    if (!options.method) return response({ ok: true })
    const body = JSON.parse(options.body)
    if (parsed.pathname === '/v1/admin/cell-status') {
      const state = cells.get(body.cellId)
      const index = [...cells.keys()].indexOf(body.cellId)
      return response({
        v: 1,
        status: {
          cellId: body.cellId,
          enabled: state.enabled,
          admissionState:
            selectorGeneration > 0
              ? index === 0
                ? 'existing-only'
                : index === 1
                ? 'migration-only'
                : index === 2
                ? 'general'
                : 'migration-only'
              : state.enabled
              ? 'general'
              : 'existing-only',
          assignments: 0,
          reservedRequests: 0,
          activityLeases: 0,
          activityRequestUnits: 0,
          outgoingMigrations: 0,
          incomingMigrations: 0,
          runtime: {
            ready: state.targetSize === 1,
            heartbeatFresh: state.targetSize === 1,
            observedRequests: state.observedRequests
          }
        }
      })
    }
    if (parsed.pathname === '/v1/admin/admission-selector/status') {
      return response({
        v: 1,
        selector: {
          generation: selectorGeneration,
          attemptId: null,
          membership: {
            existingOnly:
              selectorGeneration > 0
                ? ['staging-gce-c1']
                : [...cells]
                    .filter(([, state]) => !state.enabled)
                    .map(([cellId]) => cellId),
            migrationOnly:
              selectorGeneration > 0 ? ['staging-gce-c2', 'staging-gce-c4'] : [],
            general:
              selectorGeneration > 0
                ? ['staging-gce-c3']
                : [...cells]
                    .filter(([, state]) => state.enabled)
                    .map(([cellId]) => cellId)
          }
        },
        intent: null
      })
    }
    if (parsed.pathname === '/v1/admin/cell-state') {
      cells.get(body.cellId).enabled = body.enabled
      return response({ ok: true })
    }
    throw new Error(`unexpected fetch ${parsed.pathname}`)
  }

  return {
    cells,
    commands,
    events,
    deps: {
      command,
      commandJson,
      fetch: fetchImpl,
      adminToken: () => 'header.payload.signature',
      emit: (event) => events.push(event),
      now: () => clock,
      wait: async (ms) => {
        clock += ms
      }
    },
    sqlPolicy: () => activationPolicy
  }
}

test('accepts only explicit staging power arguments and topology', () => {
  const file = topologyFile()
  assert.equal(argumentConfig(file, 'status').mode, 'status')
  assert.equal(readStagingTopology(file).at(-1).zone, 'asia-east2-a')
  assert.throws(() => argumentConfig(file, 'destroy'))
  assert.throws(() => parseArguments(['--mode', 'sleep', '--wake-cells', 'configured']))

  const unsafe = topologyFile({
    'staging-gce-c1': {
      mig_name: 'orca-cloud-relay-gce-c1',
      zone: 'us-central1-a',
      origin: 'https://c1.relay.onorca.dev',
      initially_enabled: true
    }
  })
  assert.throws(() => readStagingTopology(unsafe), /unsafe/)

  const unreviewedRegion = topologyFile({
    'staging-gce-c4': {
      mig_name: 'orca-cloud-staging-relay-gce-c4',
      zone: 'europe-west1-b',
      origin: 'https://c4.relay-staging.onorca.dev',
      initially_enabled: false
    }
  })
  assert.throws(() => readStagingTopology(unreviewedRegion), /unsafe zone/)
})

test('refuses sleep before changing admission when a cell has active requests', async () => {
  const testHarness = harness({ observedRequests: 1 })
  await assert.rejects(
    runStagingRelayPower(argumentConfig(topologyFile(), 'sleep'), testHarness.deps),
    /still has active Relay work/
  )
  assert.equal(testHarness.commands.length, 0)
  assert.equal(testHarness.cells.get('staging-gce-c1').enabled, true)
})

test('sleeps only after disabling admission and proving zero active work', async () => {
  const testHarness = harness()
  await runStagingRelayPower(argumentConfig(topologyFile(), 'sleep'), testHarness.deps)

  assert.equal(testHarness.sqlPolicy(), 'NEVER')
  assert.deepEqual([...testHarness.cells.values()].map((cell) => cell.targetSize), [0, 0, 0, 0])
  assert.deepEqual([...testHarness.cells.values()].map((cell) => cell.enabled), [false, false, false, false])
  assert.equal(testHarness.events.at(-1).event, 'staging_relay_slept')
  assert.equal(
    testHarness.commands.filter((args) => args[0] === 'run' && args[2] === 'update').length,
    2
  )
})

test('refuses staging sleep after the monotonic selector boundary', async () => {
  const testHarness = harness({ selectorGeneration: 1 })
  await assert.rejects(
    runStagingRelayPower(argumentConfig(topologyFile(), 'sleep'), testHarness.deps),
    /cannot reverse the monotonic admission selector/
  )
  assert.deepEqual([...testHarness.cells.values()].map((cell) => cell.targetSize), [1, 1, 1, 1])
})

test('refuses to terminate workers from an unknown partially asleep state', async () => {
  const testHarness = harness({ sqlPolicy: 'NEVER', migSize: 1 })
  await assert.rejects(
    runStagingRelayPower(argumentConfig(topologyFile(), 'sleep'), testHarness.deps),
    /partially asleep with running cells/
  )
  assert.equal(testHarness.commands.length, 0)
  assert.deepEqual([...testHarness.cells.values()].map((cell) => cell.targetSize), [1, 1, 1, 1])
})

test('wakes SQL and configured cells while leaving the candidate off and disabled', async () => {
  const testHarness = harness({ sqlPolicy: 'NEVER', migSize: 0 })
  for (const cell of testHarness.cells.values()) cell.enabled = false
  for (const state of testHarness.cells.values()) state.observedRequests = 0
  await runStagingRelayPower(argumentConfig(topologyFile(), 'wake'), testHarness.deps)

  assert.equal(testHarness.sqlPolicy(), 'ALWAYS')
  assert.deepEqual([...testHarness.cells.values()].map((cell) => cell.targetSize), [1, 1, 0, 0])
  assert.deepEqual([...testHarness.cells.values()].map((cell) => cell.enabled), [true, true, false, false])
  assert.deepEqual(testHarness.events.at(-1), {
    event: 'staging_relay_woke',
    runningCells: ['staging-gce-c1', 'staging-gce-c2'],
    admissionCells: ['staging-gce-c1', 'staging-gce-c2']
  })
})

test('wakes every retained cell without rewriting selector-era admission', async () => {
  const testHarness = harness({
    sqlPolicy: 'NEVER',
    migSize: 0,
    selectorGeneration: 1
  })
  const states = [...testHarness.cells.values()]
  states[0].enabled = false
  states[1].enabled = true
  states[2].enabled = true
  states[3].enabled = true
  await runStagingRelayPower(argumentConfig(topologyFile(), 'wake'), testHarness.deps)

  assert.deepEqual(states.map((cell) => cell.targetSize), [1, 1, 1, 1])
  assert.deepEqual(states.map((cell) => cell.enabled), [false, true, true, true])
  assert.deepEqual(testHarness.events.at(-1), {
    event: 'staging_relay_woke',
    runningCells: ['staging-gce-c1', 'staging-gce-c2', 'staging-gce-c3', 'staging-gce-c4'],
    admissionCells: ['staging-gce-c3']
  })
})

test('status is read-only and reports the current billable floor controls', async () => {
  const testHarness = harness()
  await runStagingRelayPower(argumentConfig(topologyFile(), 'status'), testHarness.deps)
  assert.equal(testHarness.commands.length, 0)
  assert.equal(testHarness.events[0].project, 'onorca-cloud-staging')
  assert.equal(testHarness.events[0].sqlActivationPolicy, 'ALWAYS')
  assert.equal(testHarness.events[0].cells.length, 4)
})
