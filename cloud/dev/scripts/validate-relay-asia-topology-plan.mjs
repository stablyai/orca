import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const REGION = 'asia-east2'
const CELL_SHAPES = {
  production: {
    domain: 'relay.onorca.dev',
    project: 'onorca-cloud',
    cells: {
      'production-gce-c27': 'asia-east2-a',
      'production-gce-c28': 'asia-east2-b',
      'production-gce-c29': 'asia-east2-c'
    }
  },
  staging: {
    domain: 'relay-staging.onorca.dev',
    project: 'onorca-cloud-staging',
    cells: { 'staging-gce-c4': 'asia-east2-a' }
  }
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['plan-json', 'environment', 'cell-ids', 'region', 'image']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (!(values.environment in CELL_SHAPES)) throw new Error('--environment is invalid')
  const cells = values['cell-ids'].split(',').map((value) => value.trim()).filter(Boolean)
  const expectedCells = Object.keys(CELL_SHAPES[values.environment].cells)
  if (new Set(cells).size !== cells.length || JSON.stringify(cells.sort()) !== JSON.stringify(expectedCells.sort())) {
    throw new Error('--cell-ids must be the exact reviewed Asia topology set')
  }
  if (values.region !== REGION) throw new Error('--region must be asia-east2')
  const expectedImagePrefix = `us-central1-docker.pkg.dev/${CELL_SHAPES[values.environment].project}/orca-cloud/relay@sha256:`
  if (!values.image.startsWith(expectedImagePrefix) || !/sha256:[a-f0-9]{64}$/.test(values.image)) {
    throw new Error('--image must be the environment Relay image pinned by digest')
  }
  return { planJson: values['plan-json'], environment: values.environment, cells, image: values.image }
}

function address(resource, key) {
  return `${resource}[${JSON.stringify(key)}]`
}

function actions(change) {
  return change.change?.actions ?? []
}

function sameActions(change, expected) {
  return JSON.stringify(actions(change)) === JSON.stringify(expected)
}

function startupValue(script, name) {
  return new RegExp(`printf '${name}=%s\\\\n' '([^']+)'`).exec(script)?.[1]
}

function relayGceName(environment) {
  return environment === 'production' ? 'orca-cloud-relay-gce' : 'orca-cloud-staging-relay-gce'
}

function unknownOrMatches(value, predicate) {
  return value === undefined || value === null || predicate(String(value))
}

function requireCellTemplate(change, config, cellId) {
  const after = change.change.after
  const script = after?.metadata_startup_script ?? ''
  if (
    after?.machine_type !== 'e2-standard-4' ||
    after?.labels?.['orca-relay-cell'] !== cellId ||
    after?.labels?.['orca-relay-region'] !== REGION ||
    !unknownOrMatches(
      after?.network_interface?.[0]?.subnetwork,
      (value) => value.includes(`/regions/${REGION}/subnetworks/`)
    ) ||
    (after?.network_interface?.[0]?.access_config?.length ?? 0) !== 0 ||
    startupValue(script, 'ORCA_RELAY_REGION') !== REGION ||
    startupValue(script, 'ORCA_RELAY_CELL_CAPACITY') !== '6000' ||
    startupValue(script, 'ORCA_RELAY_DATABASE_POOL_MAX') !== '10' ||
    startupValue(script, 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP') !== '3000' ||
    startupValue(script, 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND') !== '60' ||
    startupValue(script, 'ORCA_RELAY_IMAGE_DIGEST') !== config.image.split('@')[1] ||
    !script.includes(`docker pull '${config.image}'`) ||
    !script.trimEnd().includes(`'${config.image}'`)
  ) throw new Error(`${change.address} does not have the reviewed Asia cell shape`)
}

function requireCellManager(change, config, cellId) {
  const after = change.change.after
  const hostname = cellId.split('-').at(-1)
  const version = after?.version?.[0]
  if (
    after?.zone !== CELL_SHAPES[config.environment].cells[cellId] ||
    after?.target_size !== 1 ||
    after?.version?.length !== 1 ||
    version?.name !== 'primary' ||
    !unknownOrMatches(version?.instance_template, (value) =>
      value.includes(
        `/global/instanceTemplates/${relayGceName(config.environment)}-${hostname}-`
      )) ||
    after?.update_policy?.[0]?.replacement_method !== 'RECREATE' ||
    after?.update_policy?.[0]?.max_surge_fixed !== 0 ||
    after?.update_policy?.[0]?.max_unavailable_fixed !== 1
  ) throw new Error(`${change.address} does not have the reviewed fixed-one Asia MIG shape`)
}

function requireCellBackend(change, config, cellId) {
  const after = change.change.after
  const backend = after?.backend?.[0]
  const zone = CELL_SHAPES[config.environment].cells[cellId]
  const hostname = cellId.split('-').at(-1)
  const name = `${relayGceName(config.environment)}-${hostname}`
  if (
    after?.timeout_sec !== 86_400 ||
    after?.connection_draining_timeout_sec !== 300 ||
    after?.load_balancing_scheme !== 'EXTERNAL_MANAGED' ||
    after?.protocol !== 'HTTP' ||
    after?.port_name !== 'relay' ||
    after?.session_affinity !== 'NONE' ||
    after?.health_checks?.length !== 1 ||
    !unknownOrMatches(after.health_checks[0], (value) =>
      value.endsWith(`/global/healthChecks/${relayGceName(config.environment)}-ready`)) ||
    after?.backend?.length !== 1 ||
    backend?.balancing_mode !== 'UTILIZATION' ||
    backend?.max_utilization !== 0.8 ||
    backend?.capacity_scaler !== 1 ||
    !unknownOrMatches(backend?.group, (value) =>
      value.endsWith(`/zones/${zone}/instanceGroups/${name}`))
  ) throw new Error(`${change.address} does not have the reviewed Asia backend shape`)
}

function requireNetworkResource(change, config) {
  const after = change.change.after
  const networkSuffix = `/global/networks/${relayGceName(config.environment)}`
  if (after?.region !== REGION) throw new Error(`${change.address} is outside asia-east2`)
  if (
    change.address.startsWith('google_compute_subnetwork.') &&
    (after.ip_cidr_range !== '10.42.1.0/24' ||
      after.private_ip_google_access !== true ||
      after.stack_type !== 'IPV4_ONLY' ||
      !unknownOrMatches(after.network, (value) => value.endsWith(networkSuffix)))
  ) throw new Error(`${change.address} does not have the reviewed Asia subnet shape`)
  if (
    change.address.startsWith('google_compute_router.') &&
    !unknownOrMatches(after.network, (value) => value.endsWith(networkSuffix))
  ) throw new Error(`${change.address} does not have the reviewed Asia router shape`)
  if (
    change.address.startsWith('google_compute_router_nat.') &&
    (after.nat_ip_allocate_option !== 'AUTO_ONLY' ||
      after.source_subnetwork_ip_ranges_to_nat !== 'LIST_OF_SUBNETWORKS' ||
      after.subnetwork?.length !== 1 ||
      !unknownOrMatches(after.subnetwork[0]?.name, (value) =>
        value.endsWith(
          `/regions/${REGION}/subnetworks/${relayGceName(config.environment)}-${REGION}`
        )) ||
      JSON.stringify(after.subnetwork[0]?.source_ip_ranges_to_nat) !==
        JSON.stringify(['ALL_IP_RANGES']))
  ) throw new Error(`${change.address} does not have the reviewed Asia NAT shape`)
}

function canonical(value) {
  if (!Array.isArray(value)) return JSON.stringify(value ?? [])
  return JSON.stringify([...value].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))
}

function normalizeDescription(value) {
  return { ...value, description: value.description ?? '' }
}

function normalizeMatcher(value) {
  const apiPrefix = 'https://www.googleapis.com/compute/v1/'
  const defaultService = value.default_service
  return {
    ...normalizeDescription(value),
    default_service: typeof defaultService === 'string' && defaultService.startsWith(apiPrefix)
      ? defaultService.slice(apiPrefix.length)
      : defaultService
  }
}

function requireUrlMap(change, config) {
  const before = change.change.before ?? {}
  const after = change.change.after ?? {}
  const permitted = new Set(['host_rule', 'path_matcher', 'fingerprint'])
  const changed = new Set([...Object.keys(before), ...Object.keys(after)].filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])
  ))
  if ([...changed].some((key) => !permitted.has(key))) {
    throw new Error('shared URL map changes outside host routing')
  }
  const newHosts = new Set()
  const newMatchers = new Set()
  for (const cellId of config.cells) {
    const hostname = cellId.split('-').at(-1)
    const host = `${hostname}.${CELL_SHAPES[config.environment].domain}`
    const hostRules = after.host_rule?.filter(
      (rule) =>
        rule.hosts?.length === 1 &&
        rule.hosts[0] === host &&
        rule.path_matcher === `cell-${hostname}`
    ) ?? []
    if (hostRules.length !== 1) {
      throw new Error(`shared URL map has no exact host for ${cellId}`)
    }
    const matchers = after.path_matcher?.filter(
      (matcher) =>
        matcher.name === `cell-${hostname}` &&
        unknownOrMatches(matcher.default_service, (value) =>
          value.endsWith(
            `/global/backendServices/${relayGceName(config.environment)}-${hostname}`
          ))
    ) ?? []
    if (matchers.length !== 1) {
      throw new Error(`shared URL map has no exact backend route for ${cellId}`)
    }
    newHosts.add(host)
    newMatchers.add(`cell-${hostname}`)
  }
  const preservedHostRules = (after.host_rule ?? []).filter(
    (rule) => !(rule.hosts?.length === 1 && newHosts.has(rule.hosts[0]))
  )
  const preservedMatchers = (after.path_matcher ?? []).filter(
    (matcher) => !newMatchers.has(matcher.name)
  )
  if (
    sameActions(change, ['update']) &&
    canonical(preservedHostRules.map(normalizeDescription)) !==
      canonical((before.host_rule ?? []).map(normalizeDescription)) ||
    sameActions(change, ['update']) &&
    canonical(preservedMatchers.map(normalizeMatcher)) !==
      canonical((before.path_matcher ?? []).map(normalizeMatcher))
  ) {
    throw new Error('shared URL map does not preserve every existing exact route')
  }
}

export function validateRelayAsiaTopologyPlan(plan, config) {
  if (!Array.isArray(plan.resource_changes)) throw new Error('Terraform plan has no resource changes')
  const required = new Map([
    [address('google_compute_subnetwork.relay_gce_additional', REGION), [['create'], ['no-op']]],
    [address('google_compute_router.relay_gce_additional', REGION), [['create'], ['no-op']]],
    [address('google_compute_router_nat.relay_gce_additional', REGION), [['create'], ['no-op']]],
    ['google_compute_url_map.relay_gce[0]', [['update'], ['no-op']]]
  ])
  for (const cellId of config.cells) {
    required.set(address('google_compute_instance_template.relay_gce_cell', cellId), [['create'], ['no-op']])
    required.set(address('google_compute_instance_group_manager.relay_gce_cell', cellId), [['create'], ['no-op']])
    required.set(address('google_compute_backend_service.relay_gce_cell', cellId), [['create'], ['no-op']])
  }
  const byAddress = new Map(plan.resource_changes.map((change) => [change.address, change]))
  for (const [resourceAddress, allowedActions] of required) {
    const change = byAddress.get(resourceAddress)
    if (!change || !allowedActions.some((expected) => sameActions(change, expected))) {
      throw new Error(`${resourceAddress} is absent or has an unreviewed topology action`)
    }
    const cellId = config.cells.find((candidate) => resourceAddress.endsWith(`[${JSON.stringify(candidate)}]`))
    if (resourceAddress.startsWith('google_compute_instance_template.') && cellId) {
      requireCellTemplate(change, config, cellId)
    } else if (resourceAddress.startsWith('google_compute_instance_group_manager.') && cellId) {
      requireCellManager(change, config, cellId)
    } else if (resourceAddress.startsWith('google_compute_backend_service.') && cellId) {
      requireCellBackend(change, config, cellId)
    } else if (
      resourceAddress.startsWith('google_compute_subnetwork.') ||
      resourceAddress.startsWith('google_compute_router.') ||
      resourceAddress.startsWith('google_compute_router_nat.')
    ) {
      requireNetworkResource(change, config)
    } else if (resourceAddress === 'google_compute_url_map.relay_gce[0]') {
      requireUrlMap(change, config)
    }
  }
  const changes = plan.resource_changes.filter((change) => !actions(change).every(
    (action) => action === 'no-op' || action === 'read'
  ))
  for (const change of changes) {
    const allowedActions = required.get(change.address)
    if (!allowedActions || !allowedActions.some((expected) => sameActions(change, expected))) {
      throw new Error(`${change.address} has an unreviewed topology action`)
    }
  }
  return { environment: config.environment, cells: config.cells, changes: changes.length }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = parseArguments(process.argv.slice(2))
  const plan = JSON.parse(readFileSync(config.planJson, 'utf8'))
  console.log(JSON.stringify(validateRelayAsiaTopologyPlan(plan, config)))
}
