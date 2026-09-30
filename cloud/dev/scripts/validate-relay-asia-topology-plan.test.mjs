import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  RELAY_CELL_BACKEND_TIMEOUT_SECONDS,
  RELAY_CELL_CONNECTION_DRAIN_SECONDS,
  RELAY_CELL_LOG_SAMPLE_RATE,
  parseRelayAsiaTopologyPlanArguments,
  validateRelayAsiaTopologyPlan
} from './validate-relay-asia-topology-plan.mjs'

const image = `us-central1-docker.pkg.dev/onorca-cloud-staging/orca-cloud/relay@sha256:${'a'.repeat(64)}`
const config = { environment: 'staging', cells: ['staging-gce-c4'], image }
const create = (address, after = {}) => ({ address, change: { actions: ['create'], after } })
const script = [
  `printf 'ORCA_RELAY_REGION=%s\\n' 'asia-east2'`,
  `printf 'ORCA_RELAY_CELL_CAPACITY=%s\\n' '6000'`,
  `printf 'ORCA_RELAY_DATABASE_POOL_MAX=%s\\n' '10'`,
  `printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '3000'`,
  `printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '60'`,
  `printf 'ORCA_RELAY_IMAGE_DIGEST=%s\\n' '${image.split('@')[1]}'`,
  `docker pull '${image}'`,
  `'${image}'`
].join('\n')
const resources = [
  create('google_compute_subnetwork.relay_gce_additional["asia-east2"]', {
    region: 'asia-east2', ip_cidr_range: '10.42.1.0/24', private_ip_google_access: true,
    stack_type: 'IPV4_ONLY',
    network: 'projects/p/global/networks/orca-cloud-staging-relay-gce'
  }),
  create('google_compute_router.relay_gce_additional["asia-east2"]', {
    region: 'asia-east2', network: 'projects/p/global/networks/orca-cloud-staging-relay-gce'
  }),
  create('google_compute_router_nat.relay_gce_additional["asia-east2"]', {
    region: 'asia-east2', nat_ip_allocate_option: 'AUTO_ONLY',
    source_subnetwork_ip_ranges_to_nat: 'LIST_OF_SUBNETWORKS',
    subnetwork: [{
      name: 'projects/p/regions/asia-east2/subnetworks/orca-cloud-staging-relay-gce-asia-east2',
      source_ip_ranges_to_nat: ['ALL_IP_RANGES']
    }]
  }),
  create('google_compute_instance_template.relay_gce_cell["staging-gce-c4"]', {
    machine_type: 'e2-standard-4',
    labels: { 'orca-relay-cell': 'staging-gce-c4', 'orca-relay-region': 'asia-east2' },
    network_interface: [{
      subnetwork: 'projects/p/regions/asia-east2/subnetworks/relay', access_config: []
    }],
    metadata_startup_script: script
  }),
  create('google_compute_instance_group_manager.relay_gce_cell["staging-gce-c4"]', {
    zone: 'asia-east2-a', target_size: 1,
    version: [{
      name: 'primary',
      instance_template: 'projects/p/global/instanceTemplates/orca-cloud-staging-relay-gce-c4-abc'
    }],
    update_policy: [{ replacement_method: 'RECREATE', max_surge_fixed: 0, max_unavailable_fixed: 1 }]
  }),
  create('google_compute_backend_service.relay_gce_cell["staging-gce-c4"]', {
    timeout_sec: RELAY_CELL_BACKEND_TIMEOUT_SECONDS,
    connection_draining_timeout_sec: RELAY_CELL_CONNECTION_DRAIN_SECONDS,
    load_balancing_scheme: 'EXTERNAL_MANAGED', protocol: 'HTTP', port_name: 'relay',
    session_affinity: 'NONE',
    health_checks: ['projects/p/global/healthChecks/orca-cloud-staging-relay-gce-ready'],
    backend: [{
      balancing_mode: 'UTILIZATION', max_utilization: 0.8, capacity_scaler: 1,
      group: 'projects/p/zones/asia-east2-a/instanceGroups/orca-cloud-staging-relay-gce-c4'
    }]
  }),
  {
    address: 'google_compute_url_map.relay_gce[0]',
    change: {
      actions: ['update'],
      before: { host_rule: [], path_matcher: [], fingerprint: 'old' },
      after: {
        host_rule: [{
          hosts: ['c4.relay-staging.onorca.dev'], path_matcher: 'cell-c4'
        }],
        path_matcher: [{
          name: 'cell-c4',
          default_service: 'projects/p/global/backendServices/orca-cloud-staging-relay-gce-c4'
        }],
        fingerprint: null
      }
    }
  }
]

test('accepts the exact additive staging Asia topology', () => {
  assert.deepEqual(validateRelayAsiaTopologyPlan({ resource_changes: resources }, config), {
    environment: 'staging', cells: ['staging-gce-c4'], changes: 7
  })
})

const productionImage = image.replace('onorca-cloud-staging/', 'onorca-cloud/')
const productionConfig = {
  environment: 'production', cells: ['production-gce-c30'], image: productionImage
}

// C30 joins a live Asia region: the network is a no-op and the existing C27 route is preserved.
function productionC30Plan() {
  const plan = JSON.parse(JSON.stringify(resources)
    .replaceAll('onorca-cloud-staging/', 'onorca-cloud/')
    .replaceAll('orca-cloud-staging-relay-gce', 'orca-cloud-relay-gce')
    .replaceAll('staging-gce-c4', 'production-gce-c30')
    .replaceAll('relay-gce-c4', 'relay-gce-c30')
    .replaceAll('cell-c4', 'cell-c30')
    .replaceAll('c4.relay-staging.onorca.dev', 'c30.relay.onorca.dev')
    .replaceAll("'10'", "'16'"))
  for (const network of plan.slice(0, 3)) {
    network.change.actions = ['no-op']
    network.change.before = structuredClone(network.change.after)
  }
  const existingHost = { hosts: ['c27.relay.onorca.dev'], path_matcher: 'cell-c27' }
  const existingMatcher = {
    name: 'cell-c27',
    default_service: 'projects/p/global/backendServices/orca-cloud-relay-gce-c27'
  }
  const urlMap = plan.at(-1).change
  urlMap.before = { host_rule: [existingHost], path_matcher: [existingMatcher], fingerprint: 'old' }
  urlMap.after.host_rule.unshift(structuredClone(existingHost))
  urlMap.after.path_matcher.unshift(structuredClone(existingMatcher))
  return plan
}

test('accepts the additive production C30 wave at the 16-connection Asia pool', () => {
  assert.deepEqual(
    validateRelayAsiaTopologyPlan({ resource_changes: productionC30Plan() }, productionConfig),
    { environment: 'production', cells: ['production-gce-c30'], changes: 4 }
  )
  const staleShape = productionC30Plan()
  staleShape[3].change.after.metadata_startup_script =
    staleShape[3].change.after.metadata_startup_script.replace("'16'", "'10'")
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: staleShape }, productionConfig),
    /reviewed Asia cell shape/
  )
  const wrongZone = productionC30Plan()
  wrongZone[4].change.after.zone = 'asia-east2-b'
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: wrongZone }, productionConfig),
    /fixed-one Asia MIG shape/
  )
  const liveCellTouched = productionC30Plan()
  liveCellTouched.push(create('google_compute_instance_template.relay_gce_cell["production-gce-c27"]'))
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: liveCellTouched }, productionConfig),
    /outside the planned wave/
  )
})

// The URL map pulls every cell's backend, MIG and template into a targeted plan.
const liveCellResources = ['instance_template', 'instance_group_manager', 'backend_service']
  .flatMap((kind) => ['production-gce-c1', 'production-gce-c27', 'production-gce-c28', 'production-gce-c29']
    .map((cellId) => `google_compute_${kind}.relay_gce_cell["${cellId}"]`))

test('accepts live cells the URL map pulls in only while they stay unchanged', () => {
  const plan = productionC30Plan()
  for (const address of liveCellResources) plan.push({ address, change: { actions: ['no-op'] } })
  assert.equal(
    validateRelayAsiaTopologyPlan({ resource_changes: plan }, productionConfig).changes,
    4
  )
  for (const address of liveCellResources) {
    for (const action of [['update'], ['delete'], ['create', 'delete'], ['delete', 'create']]) {
      const drifted = productionC30Plan()
      drifted.push({ address, change: { actions: action } })
      assert.throws(
        () => validateRelayAsiaTopologyPlan({ resource_changes: drifted }, productionConfig),
        new RegExp(`${address.replaceAll(/[.[\]]/g, '\\$&')} changes a live cell outside the planned wave`)
      )
    }
  }
})

test('accepts only a reviewed Asia topology wave', () => {
  const argv = (environment, cellIds, planImage) => [
    '--plan-json', 'plan.json', '--environment', environment, '--cell-ids', cellIds,
    '--region', 'asia-east2', '--image', planImage
  ]
  for (const cellIds of [
    'production-gce-c27,production-gce-c28,production-gce-c29',
    'production-gce-c29,production-gce-c27,production-gce-c28',
    'production-gce-c30'
  ]) {
    assert.doesNotThrow(
      () => parseRelayAsiaTopologyPlanArguments(argv('production', cellIds, productionImage)),
      cellIds
    )
  }
  for (const cellIds of [
    'production-gce-c27',
    'production-gce-c27,production-gce-c30',
    'production-gce-c27,production-gce-c28,production-gce-c29,production-gce-c30',
    'production-gce-c30,production-gce-c30',
    'production-gce-c31'
  ]) {
    assert.throws(
      () => parseRelayAsiaTopologyPlanArguments(argv('production', cellIds, productionImage)),
      /exact reviewed Asia topology set/,
      cellIds
    )
  }
  assert.throws(
    () => parseRelayAsiaTopologyPlanArguments(argv('staging', 'production-gce-c30', image)),
    /exact reviewed Asia topology set/
  )
})

test('accepts an idempotent empty plan', () => {
  const noChanges = structuredClone(resources).map((resource) => ({
    ...resource,
    change: {
      ...resource.change,
      actions: ['no-op'],
      before: structuredClone(resource.change.after)
    }
  }))
  assert.equal(validateRelayAsiaTopologyPlan({ resource_changes: noChanges }, config).changes, 0)
})

test('rejects a plan that omits any required topology resource', () => {
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: resources.slice(1) }, config),
    /absent or has an unreviewed topology action/
  )
})

test('rejects any US or unrelated mutation', () => {
  const plan = structuredClone(resources)
  plan.push(create('google_compute_subnetwork.relay_gce[0]'))
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: plan }, config),
    /unreviewed topology action/
  )
})

test('rejects delete and replacement actions', () => {
  for (const invalidActions of [['delete'], ['create', 'delete']]) {
    const plan = structuredClone(resources)
    plan[0].change.actions = invalidActions
    assert.throws(
      () => validateRelayAsiaTopologyPlan({ resource_changes: plan }, config),
      /unreviewed topology action/
    )
  }
})

test('rejects a cell with different limits or image', () => {
  const plan = structuredClone(resources)
  plan[3].change.after.metadata_startup_script = script.replace("'3000'", "'5000'")
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: plan }, config),
    /reviewed Asia cell shape/
  )
})

test('rejects shared URL-map changes outside exact host routing', () => {
  const plan = structuredClone(resources)
  plan[6].change.after.default_service = 'unreviewed'
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: plan }, config),
    /outside host routing/
  )
})

test('rejects removal of an existing exact route', () => {
  const plan = structuredClone(resources)
  plan[6].change.before.host_rule = [{ hosts: ['c1.relay-staging.onorca.dev'] }]
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: plan }, config),
    /preserve every existing exact route/
  )
})

test('accepts provider normalization of preserved route descriptions', () => {
  const plan = structuredClone(resources)
  const matcher = {
    name: 'cell-c1',
    description: '',
    default_service:
      'https://www.googleapis.com/compute/v1/projects/p/global/backendServices/orca-cloud-staging-relay-gce-c1'
  }
  plan[6].change.before.host_rule = [{
    description: '', hosts: ['c1.relay-staging.onorca.dev'], path_matcher: 'cell-c1'
  }]
  plan[6].change.before.path_matcher = [matcher]
  plan[6].change.after.host_rule.unshift({
    description: null, hosts: ['c1.relay-staging.onorca.dev'], path_matcher: 'cell-c1'
  })
  plan[6].change.after.path_matcher.unshift({
    ...matcher,
    description: null,
    default_service: 'projects/p/global/backendServices/orca-cloud-staging-relay-gce-c1'
  })
  assert.equal(validateRelayAsiaTopologyPlan({ resource_changes: plan }, config).changes, 7)
})

test('rejects a changed preserved route backend', () => {
  const plan = structuredClone(resources)
  plan[6].change.before.path_matcher = [{
    name: 'cell-c1',
    default_service:
      'https://www.googleapis.com/compute/v1/projects/p/global/backendServices/orca-cloud-staging-relay-gce-c1'
  }]
  plan[6].change.after.path_matcher.unshift({
    name: 'cell-c1',
    default_service: 'projects/p/global/backendServices/orca-cloud-staging-relay-gce-c2'
  })
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: plan }, config),
    /preserve every existing exact route/
  )
})

test('rejects a different Asia subnet range', () => {
  const plan = structuredClone(resources)
  plan[0].change.after.ip_cidr_range = '10.99.0.0/24'
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: plan }, config),
    /reviewed Asia subnet shape/
  )
})

test('rejects incomplete NAT, backend, and URL routing shapes', () => {
  const nat = structuredClone(resources)
  nat[2].change.after.subnetwork[0].source_ip_ranges_to_nat = []
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: nat }, config),
    /reviewed Asia NAT shape/
  )

  const backend = structuredClone(resources)
  backend[5].change.after.backend[0].group = 'projects/p/zones/asia-east2-a/instanceGroups/wrong'
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: backend }, config),
    /reviewed Asia backend shape/
  )

  const route = structuredClone(resources)
  route[6].change.after.path_matcher[0].default_service =
    'projects/p/global/backendServices/wrong'
  assert.throws(
    () => validateRelayAsiaTopologyPlan({ resource_changes: route }, config),
    /no exact backend route/
  )
})

// Terraform cannot export a local to JS, so this validator restates two topology values that
// the Asia workflow applies. Read the .tf source and equate all three statements of each: the
// local, the topology `check` assert that pins it, and the constant above.
test('the reviewed backend constants match the Terraform topology they validate', () => {
  const terraform = readFileSync(
    new URL('../../infra/terraform/relay-gce-cells.tf', import.meta.url),
    'utf8'
  )
  const local = (name) => {
    const found = new RegExp(`\\n\\s*${name}\\s*=\\s*(\\d+)\\n`).exec(terraform)
    assert.notEqual(found, null, `relay_gce_topology has no ${name}`)
    return Number(found[1])
  }
  const asserted = (name) => {
    const found =
      new RegExp(`local\\.relay_gce_topology\\.${name}\\s*==\\s*(\\d+)`).exec(terraform)
    assert.notEqual(found, null, `the topology check does not pin ${name}`)
    return Number(found[1])
  }
  for (const [name, constant] of [
    ['backend_timeout_seconds', RELAY_CELL_BACKEND_TIMEOUT_SECONDS],
    ['connection_drain_seconds', RELAY_CELL_CONNECTION_DRAIN_SECONDS]
  ]) {
    assert.equal(local(name), constant, `${name} local differs from the validator constant`)
    assert.equal(asserted(name), constant, `${name} check assert differs from the validator`)
  }
  // The sample rate is a variable, not a local, and no environment file overrides it, so the
  // declared default is what every cell backend gets. Equate the default and that absence.
  const variables = readFileSync(
    new URL('../../infra/terraform/variables.tf', import.meta.url),
    'utf8'
  )
  const declared =
    /variable "relay_gce_cell_log_sample_rate" \{[\s\S]*?\n {2}default {5}= (\d+)\n/.exec(variables)
  assert.notEqual(declared, null, 'relay_gce_cell_log_sample_rate declares no default')
  assert.equal(Number(declared[1]), RELAY_CELL_LOG_SAMPLE_RATE)
  assert.match(terraform, /sample_rate = var\.relay_gce_cell_log_sample_rate/)
  for (const environment of ['production', 'staging']) {
    assert.doesNotMatch(
      readFileSync(
        new URL(`../../infra/terraform/environments/${environment}.tfvars`, import.meta.url),
        'utf8'
      ),
      /relay_gce_cell_log_sample_rate/,
      `${environment} overrides the reviewed log sample rate`
    )
  }
})
