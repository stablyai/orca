import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  activeRevision,
  cloudRunTrafficTag,
  DIRECTOR_ADMISSION_ENVIRONMENT,
  DIRECTOR_REGIONAL_PLACEMENT_ENV,
  DIRECTOR_REGIONAL_PLACEMENT_SECRET,
  DIRECTOR_REHOME_AUDIENCE_ENV,
  DIRECTOR_REHOME_IDENTITY_ENV,
  assertRegionalRehomeDisabled,
  deployDirector,
  directorDeploymentEnvironment,
  directorCellSetAddition,
  directorStartupProbeArguments,
  directorTopologyChange,
  environmentUpdateValue,
  parseArguments,
  revisionEnvironment,
  revisionSecretEnvironment,
  suppliedAdminIdentityToken,
  taggedRevisionOrigin,
  taggedTraffic,
  trafficTags,
  waitForEvacuationCapacity
} from './deploy-relay-blue-green.mjs'

// Terraform declares these values; audited blue/green stamps the same values without targeting
// the drifted service, so this contract must fail before either side can silently diverge.
function terraformDirectorEnvironment(names) {
  const read = (name) =>
    readFileSync(fileURLToPath(new URL(`../../infra/terraform/${name}`, import.meta.url)), 'utf8')
  const relay = read('relay.tf')
  const variables = read('variables.tf')
  const production = read('environments/production.tfvars')
  return Object.fromEntries(
    names.map((name) => {
      const block = new RegExp(`name\\s*=\\s*"${name}"\\s*\\n\\s*value\\s*=\\s*([^\\n]+)`).exec(relay)
      assert.ok(block, `${name} is not set by relay.tf`)
      const variable = /var\.([a-z_]+)/.exec(block[1])
      assert.ok(variable, `${name} is not sourced from a Terraform variable`)
      // An environment override wins over the variable default, as Terraform resolves it.
      const override = new RegExp(`^${variable[1]}\\s*=\\s*(\\S+)`, 'm').exec(production)
      const fallback = new RegExp(
        `variable\\s+"${variable[1]}"[\\s\\S]*?default\\s*=\\s*(\\S+)`
      ).exec(variables)
      assert.ok(override || fallback, `${variable[1]} has neither an override nor a default`)
      return [name, String((override ?? fallback)[1]).replace(/"/g, '')]
    })
  )
}

test('director admission environment matches what Terraform deploys', () => {
  const names = Object.keys(DIRECTOR_ADMISSION_ENVIRONMENT)
  assert.deepEqual(terraformDirectorEnvironment(names), { ...DIRECTOR_ADMISSION_ENVIRONMENT })

  const relay = readFileSync(
    fileURLToPath(new URL('../../infra/terraform/relay.tf', import.meta.url)),
    'utf8'
  )
  assert.match(
    relay,
    /name = "ORCA_RELAY_REGIONAL_PLACEMENT_ENABLED"[\s\S]*?secret\s+= google_secret_manager_secret\.relay_regional_placement_enabled\.secret_id[\s\S]*?version = data\.external\.relay_serving_regional_placement_version\.result\.version/
  )
  assert.match(relay, /data "external" "relay_serving_regional_placement_version"/)
  assert.match(relay, /read-relay-serving-regional-placement-version\.mjs/)
  assert.doesNotMatch(relay, /template\[0\]\.containers\[0\]\.env/)
})

test('validates the final stamped-cell admission state', () => {
  const required = [
    '--project',
    'project',
    '--region',
    'region',
    '--service',
    'service',
    '--image',
    'image',
    '--role',
    'cell',
    '--release-id',
    'release',
    '--director-origin',
    'https://relay.example.com',
    '--admin-audience',
    'https://relay.example.com/v1/admin/drain'
  ]

  assert.equal(parseArguments(required)['final-admission'], undefined)
  assert.equal(
    parseArguments([...required, '--final-admission', 'disabled'])['final-admission'],
    'disabled'
  )
  assert.throws(() => parseArguments([...required, '--final-admission', 'sometimes']))
  assert.equal(parseArguments([...required, '--min-instances', '0'])['min-instances'], '0')
  assert.throws(() => parseArguments([...required, '--min-instances', '-1']))
  assert.throws(() =>
    parseArguments([...required, '--capacity-service-account', 'relay@example.com'])
  )
})

test('validates optional director capacity configuration', () => {
  const cells = [
    {
      id: 'staging-gce-c3',
      url: 'https://c3.relay-staging.onorca.dev',
      capacityRequests: 4_000,
      initiallyEnabled: false,
      region: 'us-central1',
      connectionHardCap: 600,
      connectionUnobservedBound: 60
    }
  ]
  const config = {
    project: 'onorca-cloud-staging',
    'capacity-service-account':
      'orca-cloud-staging-gha-cap@onorca-cloud-staging.iam.gserviceaccount.com',
    'director-cells-json': JSON.stringify(cells)
  }
  assert.deepEqual(directorDeploymentEnvironment(config), {
    ...DIRECTOR_ADMISSION_ENVIRONMENT,
    ORCA_RELAY_ADMISSION_SELECTOR_VERSION: '3',
    ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT:
      'orca-cloud-staging-gha-cap@onorca-cloud-staging.iam.gserviceaccount.com',
    ORCA_RELAY_CELLS_JSON: JSON.stringify([
      {
        id: cells[0].id,
        url: cells[0].url,
        capacityRequests: cells[0].capacityRequests,
        region: cells[0].region,
        initiallyEnabled: cells[0].initiallyEnabled,
        connectionHardCap: cells[0].connectionHardCap,
        connectionUnobservedBound: cells[0].connectionUnobservedBound
      }
    ])
  })
  assert.throws(
    () =>
      directorDeploymentEnvironment({
        ...config,
        'capacity-service-account': 'foreign@other-project.iam.gserviceaccount.com'
      }),
    /selected project/
  )
  assert.throws(
    () =>
      directorDeploymentEnvironment({
        ...config,
        'director-cells-json': JSON.stringify([{ ...cells[0], unexpected: true }])
      }),
    /invalid cell/
  )
  assert.match(
    environmentUpdateValue(directorDeploymentEnvironment(config)),
    /^\^~\^ORCA_RELAY_DATABASE_POOL_MAX=/
  )
  assert.equal(environmentUpdateValue({ FIRST: 'one', SECOND: 'two' }), 'FIRST=one,SECOND=two')
  assert.deepEqual(
    directorTopologyChange(
      JSON.stringify([
        {
          capacityRequests: 4_000,
          connectionHardCap: 600,
          connectionUnobservedBound: 60,
          id: 'staging-gce-c3',
          initiallyEnabled: false,
          region: 'us-central1',
          url: 'https://c3.relay-staging.onorca.dev'
        }
      ]),
      JSON.stringify([{ ...cells[0], connectionHardCap: 1_000 }]),
      'staging-gce-c3'
    ),
    {
      changed: true,
      value: directorDeploymentEnvironment({
        'director-cells-json': JSON.stringify([{ ...cells[0], connectionHardCap: 1_000 }])
      }).ORCA_RELAY_CELLS_JSON
    }
  )
  assert.throws(
    () =>
      directorTopologyChange(
        JSON.stringify(cells),
        JSON.stringify([{ ...cells[0], url: 'https://wrong.relay-staging.onorca.dev' }]),
        'staging-gce-c3'
      ),
    /outside the reviewed capacity pair/
  )
})

test('validates exact director runtime and regional rehome identities', () => {
  const base = [
    '--project',
    'onorca-cloud',
    '--region',
    'us-central1',
    '--service',
    'orca-cloud-relay',
    '--image',
    `relay@sha256:${'a'.repeat(64)}`,
    '--role',
    'director',
    '--release-id',
    'rehome',
    '--runtime-service-account',
    'relay-director@onorca-cloud.iam.gserviceaccount.com',
    '--rehome-director-service-account',
    'relay-director@onorca-cloud.iam.gserviceaccount.com',
    '--rehome-audience',
    'https://relay.onorca.dev/v1/admin/host-drain',
    '--expected-rehome-generation',
    '7',
    '--rehome-control-origin',
    'https://relay.onorca.dev',
    '--admin-audience',
    'https://relay.onorca.dev/v1/admin/drain'
  ]
  const config = parseArguments(base)
  assert.deepEqual(directorDeploymentEnvironment(config), {
    ...DIRECTOR_ADMISSION_ENVIRONMENT,
    ORCA_RELAY_ADMISSION_SELECTOR_VERSION: '3',
    ORCA_RELAY_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
    [DIRECTOR_REHOME_IDENTITY_ENV]:
      'relay-director@onorca-cloud.iam.gserviceaccount.com',
    [DIRECTOR_REHOME_AUDIENCE_ENV]:
      'https://relay.onorca.dev/v1/admin/host-drain'
  })
  const missingAudience = [...base]
  missingAudience.splice(missingAudience.indexOf('--rehome-audience'), 2)
  assert.throws(() => parseArguments(missingAudience), /configured together/)
  const invalidOrigin = [...base]
  invalidOrigin[invalidOrigin.indexOf('--rehome-control-origin') + 1] =
    'http://relay.onorca.dev'
  assert.throws(
    () => parseArguments(invalidOrigin),
    /HTTPS origin/
  )
  const mutableImage = [...base]
  mutableImage[mutableImage.indexOf('--image') + 1] = 'relay:latest'
  assert.throws(() => parseArguments(mutableImage), /immutable digest/)
})

test('requires durable regional rehome control to be disabled at the exact generation', async () => {
  const config = {
    'admin-audience': 'https://relay.onorca.dev/v1/admin/drain',
    'expected-rehome-generation': '7'
  }
  const environment = process.env.ORCA_RELAY_ADMIN_ID_TOKEN
  process.env.ORCA_RELAY_ADMIN_ID_TOKEN = 'aaa.bbb.ccc'
  try {
    const control = await assertRegionalRehomeDisabled(
      config,
      'https://candidate.example.test',
      async (url, init) => {
        assert.equal(url, 'https://candidate.example.test/v1/admin/regional-rehome-control')
        assert.equal(init.headers.authorization, 'Bearer aaa.bbb.ccc')
        return new Response(JSON.stringify({
          v: 1,
          control: { generation: 7, enabled: false }
        }))
      }
    )
    assert.equal(control.generation, 7)
    await assert.rejects(
      assertRegionalRehomeDisabled(config, 'https://candidate.example.test', async () =>
        new Response(JSON.stringify({
          v: 1,
          control: { generation: 8, enabled: false }
        }))
      ),
      /expected generation/
    )
    await assert.rejects(
      assertRegionalRehomeDisabled(config, 'https://candidate.example.test', async () =>
        new Response(JSON.stringify({
          v: 1,
          control: { generation: 7, enabled: true }
        }))
      ),
      /durably disabled/
    )
  } finally {
    if (environment === undefined) delete process.env.ORCA_RELAY_ADMIN_ID_TOKEN
    else process.env.ORCA_RELAY_ADMIN_ID_TOKEN = environment
  }
})

test('rejects literal regional placement changes outside the runtime-setting step', () => {
  const base = {
    project: 'onorca-cloud',
    region: 'us-central1',
    service: 'orca-cloud-relay',
    image: `us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay@sha256:${'a'.repeat(64)}`,
    role: 'director',
    'release-id': 'regional-kill-switch'
  }
  const args = Object.entries(base).flatMap(([key, value]) => [`--${key}`, value])

  assert.doesNotThrow(() => parseArguments(args))
  assert.throws(
    () => parseArguments([...args, '--regional-placement-enabled', 'false']),
    /audited runtime-setting step/
  )
})

test('appends disabled Asia cells without changing the existing director topology', () => {
  const current = [
    {
      id: 'production-gce-c26',
      url: 'https://c26.relay.onorca.dev',
      capacityRequests: 4_000,
      initiallyEnabled: true,
      connectionHardCap: 1_000,
      connectionUnobservedBound: 60
    }
  ]
  const asia = {
    id: 'production-gce-c27',
    url: 'https://c27.relay.onorca.dev',
    region: 'asia-east2',
    capacityRequests: 6_000,
    initiallyEnabled: false,
    connectionHardCap: 3_000,
    connectionUnobservedBound: 60
  }

  assert.deepEqual(
    directorCellSetAddition(
      JSON.stringify(current),
      JSON.stringify([asia, { ...current[0], region: 'us-central1' }])
    ),
    {
      changed: true,
      value: directorDeploymentEnvironment({
        'director-cells-json': JSON.stringify([asia, { ...current[0], region: 'us-central1' }])
      }).ORCA_RELAY_CELLS_JSON
    }
  )
  const exact = JSON.stringify([{ ...current[0], region: 'us-central1' }, asia])
  assert.deepEqual(directorCellSetAddition(exact, exact), {
    changed: false,
    value: directorDeploymentEnvironment({ 'director-cells-json': exact })
      .ORCA_RELAY_CELLS_JSON
  })
  assert.throws(
    () => directorCellSetAddition(JSON.stringify(current), JSON.stringify([{ ...current[0], region: 'us-central1', capacityRequests: 6_000 }, asia])),
    /changes an existing cell/
  )
  assert.throws(
    () => directorCellSetAddition(JSON.stringify(current), JSON.stringify([{ ...current[0], region: 'us-central1' }, { ...asia, initiallyEnabled: true }])),
    /must start disabled/
  )
})

test('pins a director startup probe above the bounded reconciliation window', () => {
  assert.deepEqual(directorStartupProbeArguments('director'), [
    '--startup-probe',
    'tcpSocket.port=8080,timeoutSeconds=120,periodSeconds=120,failureThreshold=1'
  ])
  assert.deepEqual(directorStartupProbeArguments('cell'), [])
})

test('bounds traffic tags by the Cloud Run service-plus-tag contract', () => {
  const service = 'orca-cloud-relay-staging-c1'
  const candidate = cloudRunTrafficTag(service, 'candidate', '29247170608-1-19cc312a')
  assert.match(candidate, /^candidate-[a-f0-9]{9}$/)
  assert.equal(service.length + candidate.length, 46)
  assert.equal(candidate, cloudRunTrafficTag(service, 'candidate', '29247170608-1-19cc312a'))
  assert.notEqual(candidate, cloudRunTrafficTag(service, 'candidate', '29247170608-2-19cc312a'))
  assert.throws(() => cloudRunTrafficTag(`${service}-too-long`, 'candidate', 'release'))
})

test('derives and validates a Cloud Run tagged revision origin', () => {
  assert.equal(
    taggedRevisionOrigin(
      'https://orca-cloud-relay-staging-c1-gjzz5mc7ka-uc.a.run.app',
      'candidate-123'
    ),
    'https://candidate-123---orca-cloud-relay-staging-c1-gjzz5mc7ka-uc.a.run.app'
  )
  assert.throws(() => taggedRevisionOrigin('https://relay-staging.onorca.dev', 'candidate-123'))
  assert.throws(() =>
    taggedRevisionOrigin(
      'https://orca-cloud-relay-staging-c1-gjzz5mc7ka-uc.a.run.app',
      '123-invalid'
    )
  )
})

test('requires exactly one active revision and reads queried tag metadata', () => {
  const service = {
    status: {
      traffic: [
        { percent: 100, revisionName: 'relay-00001-old' },
        {
          percent: 0,
          revisionName: 'relay-00002-new',
          tag: 'candidate-123',
          url: 'https://candidate-123---relay-hash-uc.a.run.app'
        }
      ]
    }
  }
  assert.equal(activeRevision(service), 'relay-00001-old')
  assert.deepEqual(taggedTraffic(service, 'candidate-123'), {
    origin: 'https://candidate-123---relay-hash-uc.a.run.app',
    revision: 'relay-00002-new'
  })
  assert.throws(() =>
    activeRevision({ status: { traffic: [{ percent: 50 }, { percent: 50 }] } })
  )
  assert.deepEqual(trafficTags(service), ['candidate-123'])
})

function directorHarness({
  deployFailure,
  deleteFailure,
  cleanupReportsFailure = false,
  cleanupFailsBeforeRemoval = false,
  servingMinimum = 1,
  servingMaximum = 5,
  // Reproduces gcloud dropping minScale from a newly created revision.
  dropRequestedMinimum = false,
  servingServiceAccount,
  servingImageDigest = `sha256:${'f'.repeat(64)}`
} = {}) {
  const state = {
    activeRevision: 'relay-00001-old',
    tags: new Map([['candidate-old', 'relay-00000-stale']]),
    revisions: new Map([
      ['relay-00000-stale', { env: { ORCA_RELAY_ROLE: 'director' }, minimum: 1, maximum: 5 }],
      [
        'relay-00001-old',
        {
          env: {
            ORCA_RELAY_ROLE: 'director'
          },
          secrets: {
            [DIRECTOR_REGIONAL_PLACEMENT_ENV]: {
              secret: DIRECTOR_REGIONAL_PLACEMENT_SECRET,
              version: '1'
            }
          },
          minimum: servingMinimum,
          maximum: servingMaximum,
          serviceAccount: servingServiceAccount,
          image: `relay@${servingImageDigest}`
        }
      ]
    ]),
    nextRevision: 2
  }
  const removed = []
  const healthProtocols = []
  let pendingCleanupFailure = cleanupFailsBeforeRemoval
  const operations = {
    describeService: () => ({
      status: {
        traffic: [
          { percent: 100, revisionName: state.activeRevision },
          ...[...state.tags].map(([tag, revisionName]) => ({
            tag,
            revisionName,
            url: `https://${tag}---relay-hash-uc.a.run.app`
          }))
        ]
      }
    }),
    describeRevision: (_config, revision) => {
      const value = state.revisions.get(revision)
      return {
        metadata: {
          annotations: {
            'autoscaling.knative.dev/minScale': String(value?.minimum ?? 0),
            'autoscaling.knative.dev/maxScale': String(value?.maximum ?? 5)
          }
        },
        spec: {
          serviceAccountName: value?.serviceAccount,
          containers: [
            {
              image: value?.image,
              env: [
                ...Object.entries(value?.env ?? {}).map(([name, value]) => ({ name, value })),
                ...Object.entries(value?.secrets ?? {}).map(([name, secretKeyRef]) => ({
                  name,
                  valueSource: { secretKeyRef }
                }))
              ]
            }
          ]
        }
      }
    },
    deployCandidate: (config, tag, env, image, minimum, maximum, regionalVersion) => {
      const revision = `relay-${String(state.nextRevision++).padStart(5, '0')}-new`
      state.revisions.set(revision, {
        env: { ORCA_RELAY_ROLE: 'director', ...env },
        secrets: {
          [DIRECTOR_REGIONAL_PLACEMENT_ENV]: {
            secret: DIRECTOR_REGIONAL_PLACEMENT_SECRET,
            version: regionalVersion
          }
        },
        minimum: dropRequestedMinimum ? 0 : Number(minimum ?? 1),
        maximum,
        serviceAccount:
          config['runtime-service-account'] ??
          state.revisions.get(state.activeRevision)?.serviceAccount,
        image: image ?? state.revisions.get(state.activeRevision)?.image
      })
      state.tags.set(tag, revision)
      if (deployFailure) throw deployFailure
    },
    listRevisions: () =>
      [...state.revisions].map(([name]) => ({ metadata: { name } })),
    deleteRevision: (_config, revision) => {
      if (deleteFailure) throw deleteFailure
      state.revisions.delete(revision)
    },
    updateTraffic: (_config, args) => {
      const remove = args.find((argument) => argument.startsWith('--remove-tags='))
      if (remove) {
        const tags = remove.slice('--remove-tags='.length).split(',')
        removed.push(tags)
        if (pendingCleanupFailure && tags.includes('candidate-new')) {
          pendingCleanupFailure = false
          throw new Error('failed to remove promoted candidate tag')
        }
        for (const tag of tags) state.tags.delete(tag)
        if (cleanupReportsFailure) throw new Error('gcloud reported failed latest revision')
        return
      }
      const promote = args.find((argument) => argument.startsWith('--to-tags='))
      assert.ok(promote)
      const tag = promote.slice('--to-tags='.length).split('=')[0]
      state.activeRevision = state.tags.get(tag)
    },
    waitForHealth: async (_origin, connectionCapacityProtocol) => {
      healthProtocols.push(connectionCapacityProtocol)
    }
  }
  return { state, removed, healthProtocols, operations }
}

test('director deploy removes stale and promoted Cloud Run tags', async () => {
  const harness = directorHarness()
  const config = {
    project: 'onorca-cloud-staging',
    'capacity-service-account':
      'orca-cloud-staging-gha-cap@onorca-cloud-staging.iam.gserviceaccount.com'
  }
  await deployDirector(config, 'candidate-new', harness.operations)
  assert.deepEqual(harness.removed, [['candidate-old'], ['candidate-new']])
  assert.equal(harness.state.activeRevision, 'relay-00003-new')
  assert.deepEqual([...harness.state.tags.keys()], ['selector-rollback'])
  assert.deepEqual([...harness.state.revisions.keys()], [
    'relay-00000-stale',
    'relay-00001-old',
    'relay-00002-new',
    'relay-00003-new'
  ])
  for (const revision of ['relay-00002-new', 'relay-00003-new']) {
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(harness.state.revisions.get(revision).env).filter(([key]) =>
          key in DIRECTOR_ADMISSION_ENVIRONMENT
        )
      ),
      DIRECTOR_ADMISSION_ENVIRONMENT
    )
    assert.equal(
      harness.state.revisions.get(revision).env.ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT,
      config['capacity-service-account']
    )
  }
  assert.deepEqual(harness.healthProtocols, [undefined, undefined])
})

test('director deploy stamps the durable regional placement secret reference', async () => {
  const harness = directorHarness()
  await deployDirector({}, 'candidate-new', harness.operations)
  for (const revision of ['relay-00002-new', 'relay-00003-new']) {
    assert.deepEqual(
      harness.state.revisions.get(revision).secrets[DIRECTOR_REGIONAL_PLACEMENT_ENV],
      { secret: DIRECTOR_REGIONAL_PLACEMENT_SECRET, version: '1' }
    )
  }
})

test('bootstraps both rollback and candidate onto the distinct director identity', async () => {
  const predecessor = 'relay-runtime@onorca-cloud.iam.gserviceaccount.com'
  const director = 'relay-director@onorca-cloud.iam.gserviceaccount.com'
  const harness = directorHarness({ servingServiceAccount: predecessor })
  const inspected = []
  harness.operations.assertRegionalRehomeDisabled = async (_config, origin) => {
    inspected.push(origin)
  }
  await deployDirector({
    project: 'onorca-cloud',
    'runtime-service-account': director,
    'predecessor-runtime-service-account': predecessor,
    'predecessor-image-digest': `sha256:${'f'.repeat(64)}`,
    'bootstrap-runtime-identity': 'true',
    'expected-rehome-generation': '0',
    'rehome-control-origin': 'https://relay.onorca.dev'
  }, 'candidate-new', harness.operations)
  assert.equal(
    harness.state.revisions.get(harness.state.activeRevision).serviceAccount,
    director
  )
  assert.equal(
    harness.state.revisions.get(harness.state.tags.get('selector-rollback')).serviceAccount,
    director
  )
  assert.deepEqual(inspected, [
    'https://selector-rollback---relay-hash-uc.a.run.app',
    'https://candidate-new---relay-hash-uc.a.run.app'
  ])
})

test('steady-state director deploy rejects the predecessor identity', async () => {
  const harness = directorHarness({
    servingServiceAccount: 'relay-runtime@onorca-cloud.iam.gserviceaccount.com'
  })
  await assert.rejects(deployDirector({
    'runtime-service-account': 'relay-director@onorca-cloud.iam.gserviceaccount.com'
  }, 'candidate-new', harness.operations), /unexpected runtime service account/)
})

test('director deploy prunes old revisions when requested', async () => {
  const harness = directorHarness()
  await deployDirector({ 'prune-revisions': 'true' }, 'candidate-new', harness.operations)
  assert.deepEqual([...harness.state.revisions.keys()], [
    'relay-00002-new',
    'relay-00003-new'
  ])
  assert.deepEqual(harness.healthProtocols, [2, 2])
})

test('a prune failure preserves the active and rollback traffic pair', async () => {
  const harness = directorHarness({ deleteFailure: new Error('injected delete failure') })
  await assert.rejects(
    deployDirector({ 'prune-revisions': 'true' }, 'candidate-new', harness.operations),
    /injected delete failure/
  )
  assert.equal(harness.state.activeRevision, 'relay-00003-new')
  assert.deepEqual([...harness.state.tags.keys()], ['selector-rollback'])
})

test('director deploy removes a candidate tag left by a failed update', async () => {
  const failure = new Error('candidate failed to become ready')
  const harness = directorHarness({ deployFailure: failure })
  await assert.rejects(deployDirector({}, 'candidate-new', harness.operations), failure)
  assert.deepEqual(harness.removed, [['candidate-old'], ['selector-rollback']])
  assert.equal(harness.state.tags.size, 0)
})

test('director candidate inherits the serving warm-instance floor', async () => {
  const harness = directorHarness({ servingMinimum: 5 })
  await deployDirector({}, 'candidate-new', harness.operations)
  const serving = harness.state.revisions.get(harness.state.activeRevision)
  assert.equal(serving.minimum, 5)
  // The standby rollback revision must stay cold.
  const rollback = harness.state.revisions.get(harness.state.tags.get('selector-rollback'))
  assert.equal(rollback.minimum, 0)
})

test('director deploy rejects a serving maximum above the checked budget', async () => {
  const harness = directorHarness({ servingMaximum: 6 })
  await assert.rejects(
    deployDirector({ 'max-instances': '5' }, 'candidate-new', harness.operations),
    /holds 6 maximum instances, expected 5/
  )
})

test('an explicit --min-instances still overrides the serving floor', async () => {
  const harness = directorHarness({ servingMinimum: 5 })
  await deployDirector({ 'min-instances': '0' }, 'candidate-new', harness.operations)
  assert.equal(harness.state.revisions.get(harness.state.activeRevision).minimum, 0)
})

test('director deploy refuses to move traffic onto a candidate that lost the floor', async () => {
  const harness = directorHarness({ servingMinimum: 5, dropRequestedMinimum: true })
  await assert.rejects(
    deployDirector({}, 'candidate-new', harness.operations),
    /candidate holds 0 minimum instances, expected 5/
  )
  // Traffic never moved, so the original revision still serves.
  assert.equal(harness.state.activeRevision, 'relay-00001-old')
})

test('director deploy rejects unrelated revision-shape drift', async () => {
  const harness = directorHarness()
  const describeRevision = harness.operations.describeRevision
  harness.operations.describeRevision = (config, revision) => {
    const described = describeRevision(config, revision)
    described.spec.containerConcurrency = revision === 'relay-00001-old' ? 80 : 1_000
    return described
  }
  await assert.rejects(
    deployDirector({}, 'candidate-new', harness.operations),
    /unrelated revision shape/
  )
  assert.equal(harness.state.activeRevision, 'relay-00001-old')
})

test('director cleanup verifies success when gcloud reports a stale revision failure', async () => {
  const harness = directorHarness({ cleanupReportsFailure: true })
  await deployDirector({}, 'candidate-new', harness.operations)
  assert.deepEqual(harness.removed, [['candidate-old'], ['candidate-new']])
  assert.deepEqual([...harness.state.tags.keys()], ['selector-rollback'])
})

test('director deploy restores rollback traffic after promoted-tag cleanup fails', async () => {
  const harness = directorHarness({ cleanupFailsBeforeRemoval: true })
  await assert.rejects(
    deployDirector({}, 'candidate-new', harness.operations),
    /failed to remove promoted candidate tag/
  )
  assert.equal(
    harness.state.activeRevision,
    harness.state.tags.get('selector-rollback')
  )
  assert.deepEqual([...harness.state.tags.keys()], ['selector-rollback'])
})

test('reads only literal revision environment values', () => {
  assert.deepEqual(
    revisionEnvironment({
      spec: {
        containers: [
          {
            env: [
              { name: 'ORCA_RELAY_CELL_ID', value: 'staging-c1' },
              { name: 'ORCA_RELAY_CELL_CAPACITY', value: '900' },
              { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'database' } } }
            ]
          }
        ]
      }
    }),
    { ORCA_RELAY_CELL_ID: 'staging-c1', ORCA_RELAY_CELL_CAPACITY: '900' }
  )
})

test('reads only Secret Manager revision environment references', () => {
  assert.deepEqual(
    revisionSecretEnvironment({
      spec: {
        containers: [{ env: [
          { name: 'LITERAL', value: 'true' },
          {
            name: DIRECTOR_REGIONAL_PLACEMENT_ENV,
            valueSource: { secretKeyRef: {
              secret: DIRECTOR_REGIONAL_PLACEMENT_SECRET,
              version: 'latest'
            } }
          },
          {
            name: 'GCP_SECRET_SHAPE',
            valueFrom: { secretKeyRef: { name: 'gcp-secret', key: '2' } }
          }
        ] }]
      }
    }),
    {
      [DIRECTOR_REGIONAL_PLACEMENT_ENV]: {
        secret: DIRECTOR_REGIONAL_PLACEMENT_SECRET,
        version: 'latest'
      },
      GCP_SECRET_SHAPE: {
        secret: 'gcp-secret',
        version: '2'
      }
    }
  )
})

test('accepts only a bounded JWT-shaped supplied admin identity token', () => {
  assert.equal(suppliedAdminIdentityToken({}), null)
  assert.equal(suppliedAdminIdentityToken({ ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' }), 'aaa.bbb.ccc')
  assert.throws(() => suppliedAdminIdentityToken({ ORCA_RELAY_ADMIN_ID_TOKEN: '' }))
  assert.throws(() => suppliedAdminIdentityToken({ ORCA_RELAY_ADMIN_ID_TOKEN: 'not-a-jwt' }))
  assert.throws(() =>
    suppliedAdminIdentityToken({ ORCA_RELAY_ADMIN_ID_TOKEN: `aaa.${'b'.repeat(8_190)}.ccc` })
  )
})

test('waits for authenticated target readiness without hiding other capacity errors', async () => {
  let attempts = 0
  const capacity = await waitForEvacuationCapacity(
    async () => {
      attempts += 1
      if (attempts < 3) throw new Error('/v1/admin/evacuation-capacity failed: target_cell_unavailable')
      return { requiredTargetUnits: 2, availableTargetUnits: 4_000 }
    },
    'source',
    'target',
    { pollIntervalMs: 1, timeoutMs: 100 }
  )
  assert.equal(attempts, 3)
  assert.equal(capacity.availableTargetUnits, 4_000)
  await assert.rejects(
    waitForEvacuationCapacity(async () => {
      throw new Error('/v1/admin/evacuation-capacity failed: forbidden')
    }, 'source', 'target'),
    /forbidden/
  )
})
