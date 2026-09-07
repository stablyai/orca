import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateRelayAsiaTopologyPlan } from './validate-relay-asia-topology-plan.mjs'

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
    timeout_sec: 86_400, connection_draining_timeout_sec: 300,
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
