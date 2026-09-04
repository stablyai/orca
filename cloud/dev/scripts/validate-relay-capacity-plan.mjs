import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SERVICE_ACCOUNT_EMAIL =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['mode', 'cell-id', 'hard-cap', 'unobserved-bound']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (!['cell', 'bootstrap-cell', 'same-cap-cell', 'same-cap-image'].includes(values.mode)) {
    throw new Error('--mode must be cell, bootstrap-cell, same-cap-cell, or same-cap-image')
  }
  const integer = (key) => {
    const value = Number(values[key])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${key} is invalid`)
    return value
  }
  if (!values.image) throw new Error('missing --image')
  if (values.mode === 'bootstrap-cell' && !values['capacity-service-account']) {
    throw new Error('missing --capacity-service-account')
  }
  if (
    values.mode === 'same-cap-cell' &&
    (!values['rollback-image'] ||
      !values['rehome-director-service-account'] ||
      !values['rehome-audience'])
  ) throw new Error('same-cap validation requires rollback image and rehome trust config')
  if (values.mode === 'same-cap-image' && !values['rollback-image']) {
    throw new Error('same-cap image validation requires a rollback image')
  }
  if (
    values['capacity-service-account'] !== undefined &&
    !SERVICE_ACCOUNT_EMAIL.test(values['capacity-service-account'])
  ) {
    throw new Error('--capacity-service-account is invalid')
  }
  return {
    mode: values.mode,
    cellId: values['cell-id'],
    hardCap: integer('hard-cap'),
    unobservedBound: integer('unobserved-bound'),
    image: values.image,
    capacityServiceAccount: values['capacity-service-account'],
    rollbackImage: values['rollback-image'],
    rehomeDirectorServiceAccount: values['rehome-director-service-account'],
    rehomeAudience: values['rehome-audience']
  }
}

function mutations(plan) {
  if (!Array.isArray(plan.resource_changes)) throw new Error('Terraform plan has no resource changes')
  return plan.resource_changes.filter(({ change }) => {
    const actions = change?.actions
    return Array.isArray(actions) && !actions.every((action) => ['no-op', 'read'].includes(action))
  })
}

function sameActions(change, expected) {
  return JSON.stringify(change.change?.actions) === JSON.stringify(expected)
}

function changedPaths(before, after, path = []) {
  if (Object.is(before, after)) return []
  const beforeObject = before !== null && typeof before === 'object'
  const afterObject = after !== null && typeof after === 'object'
  if (!beforeObject || !afterObject || Array.isArray(before) !== Array.isArray(after)) {
    return [path.join('.')]
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].flatMap((key) => changedPaths(before[key], after[key], [...path, key]))
}

function unknownPaths(value, path = []) {
  if (value === true) return [path.join('.')]
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, nested]) => unknownPaths(nested, [...path, key]))
}

function valueAtPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value)
}

function providerDefaultPaths(change, paths) {
  const empty = (value) =>
    value === '' ||
    value === 0 ||
    (Array.isArray(value) && value.length === 0) ||
    (value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  return paths.filter(
    (path) =>
      empty(valueAtPath(change.change.before, path)) &&
      valueAtPath(change.change.after, path) === null
  )
}

function canonicalResourcePaths(change, paths) {
  const canonical = (value) =>
    typeof value === 'string'
      ? value.replace('https://www.googleapis.com/compute/v1/', '')
      : value
  return paths.filter(
    (path) =>
      canonical(valueAtPath(change.change.before, path)) ===
      canonical(valueAtPath(change.change.after, path))
  )
}

function bootstrapRestartNormalizationPaths(change, mode) {
  if (!['bootstrap-cell', 'same-cap-cell', 'same-cap-image'].includes(mode)) return []
  const policyMatches =
    valueAtPath(change.change.before, 'update_policy.0.minimal_action') === 'RESTART' &&
    valueAtPath(change.change.after, 'update_policy.0.minimal_action') === 'REPLACE'
  const priorVersion = valueAtPath(change.change.before, 'version.0.name')
  const versionMatches =
    typeof priorVersion === 'string' &&
    /^0\/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/.test(priorVersion) &&
    valueAtPath(change.change.after, 'version.0.name') === 'primary'
  return policyMatches && versionMatches
    ? ['update_policy.0.minimal_action', 'version.0.name']
    : []
}

function requireOnlyPaths(change, allowed, required = [], allowedUnknown = new Set()) {
  const paths = changedPaths(change.change.before, change.change.after)
  const unknown = unknownPaths(change.change.after_unknown)
  const unexpected = paths.filter((path) => !allowed.has(path))
  const unexpectedUnknown = unknown.filter((path) => !allowedUnknown.has(path))
  if (
    unexpected.length > 0 ||
    unexpectedUnknown.length > 0 ||
    required.some((path) => !paths.includes(path))
  ) {
    throw new Error(`${change.address} changes outside the reviewed capacity fields`)
  }
}

function relayImage(script) {
  const lines = script.split('\n')
  const starts = lines.flatMap((line, index) =>
    line === 'docker run --detach \\' ? [index] : [])
  const commands = starts.map((start) => {
    const end = lines.findIndex((line, index) => index > start && !line.endsWith(' \\'))
    return end < 0 ? [] : lines.slice(start, end + 1)
  })
  const relayCommands = commands.filter((command) =>
    command.filter((line) => line === '  --name orca-relay \\').length === 1)
  if (relayCommands.length !== 1) return null
  const command = relayCommands[0]
  const image = /^  '([^'\n]+@sha256:[a-f0-9]{64})'$/.exec(command.at(-1))?.[1]
  const digests = [...command.join('\n').matchAll(/'([^'\n]+@sha256:[a-f0-9]{64})'/g)]
  return image && digests.length === 1 ? image : null
}

function normalizedStartupScript(
  script,
  stripCapacityIdentity = false,
  stripRehomeConfig = false,
  preserveCapacity = false
) {
  const image = relayImage(script)
  if (!image) throw new Error('cell plan startup script has no Relay image')
  const digest = image.split('@')[1]
  const capacityAssignment =
    /^  printf 'ORCA_RELAY_CELL_CONNECTION_(?:HARD_CAP|UNOBSERVED_BOUND)=%s\\n' '[0-9]+'$/
  const capacityIdentity =
    /^  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com'$/
  const rehomeConfig =
    /^  printf 'ORCA_RELAY_REHOME_(?:DIRECTOR_SERVICE_ACCOUNT|AUDIENCE)=%s\\n' '[^'\n]+'$/
  return script
    .split('\n')
    .filter(
      (line) =>
        (preserveCapacity || !capacityAssignment.test(line)) &&
        (!stripCapacityIdentity || !capacityIdentity.test(line)) &&
        (!stripRehomeConfig || !rehomeConfig.test(line))
    )
    .join('\n')
    .replaceAll(image, '<relay-image>')
    .replaceAll(digest, '<relay-image-digest>')
}

function hasExactSingleAssignment(lines, pattern, expected) {
  const assignments = lines.filter((line) => pattern.test(line))
  return assignments.length === 1 && assignments[0] === expected
}

function requireDesiredStartupScript(script, config) {
  const lines = typeof script === 'string' ? script.split('\n') : []
  const expected = [
    [
      /^  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '[0-9]+'$/,
      `  printf 'ORCA_RELAY_CELL_CONNECTION_HARD_CAP=%s\\n' '${config.hardCap}'`
    ],
    [
      /^  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '[0-9]+'$/,
      `  printf 'ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND=%s\\n' '${config.unobservedBound}'`
    ]
  ]
  if (config.mode === 'bootstrap-cell') {
    expected.push([
      /^  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com'$/,
      `  printf 'ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT=%s\\n' '${config.capacityServiceAccount}'`
    ])
  }
  if (config.mode === 'same-cap-cell') {
    expected.push(
      [
        /^  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '[^'\n]+'$/,
        `  printf 'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT=%s\\n' '${config.rehomeDirectorServiceAccount}'`
      ],
      [
        /^  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '[^'\n]+'$/,
        `  printf 'ORCA_RELAY_REHOME_AUDIENCE=%s\\n' '${config.rehomeAudience}'`
      ]
    )
  }
  if (
    typeof script !== 'string' ||
    relayImage(script) !== config.image ||
    expected.some(([pattern, line]) => !hasExactSingleAssignment(lines, pattern, line))
  ) {
    throw new Error('cell plan does not contain the reviewed image and capacity')
  }
}

function plannedResources(module) {
  if (!module) return []
  return [
    ...(module.resources ?? []),
    ...(module.child_modules ?? []).flatMap(plannedResources)
  ]
}

function canonicalResource(value) {
  return typeof value === 'string'
    ? value.replace('https://www.googleapis.com/compute/v1/', '')
    : value
}

function requireDesiredPlannedCell(plan, config) {
  const resources = plannedResources(plan.planned_values?.root_module)
  const templateAddress = `google_compute_instance_template.relay_gce_cell[${JSON.stringify(config.cellId)}]`
  const managerAddress = `google_compute_instance_group_manager.relay_gce_cell[${JSON.stringify(config.cellId)}]`
  const template = resources.find(({ address }) => address === templateAddress)?.values
  const manager = resources.find(({ address }) => address === managerAddress)?.values
  if (!template || !manager) throw new Error('convergence plan has no exact planned C26 state')
  requireDesiredStartupScript(template.metadata_startup_script, config)
  const templateReference = canonicalResource(template.self_link ?? template.id)
  const managerReference = canonicalResource(manager.version?.[0]?.instance_template)
  if (!templateReference || templateReference !== managerReference) {
    throw new Error('convergence plan does not bind the MIG to the reviewed template')
  }
}

function validateManagerUpdate(manager, config) {
  if (!sameActions(manager, ['update'])) {
    throw new Error('cell plan has unexpected MIG actions')
  }
  const managerComputed = new Set([
    'fingerprint',
    'operation',
    'status',
    'version.0.instance_template'
  ])
  const managerUnknown = unknownPaths(manager.change.after_unknown)
  requireOnlyPaths(
    manager,
    new Set([
      'version.0.instance_template',
      ...bootstrapRestartNormalizationPaths(manager, config.mode),
      ...managerUnknown.filter((path) => managerComputed.has(path))
    ]),
    ['version.0.instance_template'],
    managerComputed
  )
}

function requireReplacementTemplateDependency(plan, template, manager) {
  const configuredManager = plan.configuration?.root_module?.resources?.find(
    ({ address }) => address === 'google_compute_instance_group_manager.relay_gce_cell'
  )
  const expectedVersionExpression = [{
    instance_template: {
      references: ['google_compute_instance_template.relay_gce_cell', 'each.key']
    },
    name: { constant_value: 'primary' }
  }]
  if (
    JSON.stringify(configuredManager?.expressions?.version) !==
      JSON.stringify(expectedVersionExpression) ||
    template.change.after?.self_link != null ||
    template.change.after_unknown?.self_link !== true ||
    manager.change.after?.version?.[0]?.instance_template != null ||
    manager.change.after_unknown?.version?.[0]?.instance_template !== true
  ) {
    throw new Error('cell plan does not bind the MIG to the reviewed template dependency')
  }
}

function cellPlan(plan, changes, config) {
  const templateAddress = `google_compute_instance_template.relay_gce_cell[${JSON.stringify(config.cellId)}]`
  const managerAddress = `google_compute_instance_group_manager.relay_gce_cell[${JSON.stringify(config.cellId)}]`
  const template = changes.find(
    ({ address, deposed }) => address === templateAddress && deposed === undefined
  )
  const manager = changes.find(({ address }) => address === managerAddress)
  const obsoleteTemplates = changes.filter(
    ({ address, deposed }) => address === templateAddress && typeof deposed === 'string'
  )
  const allowsObsoleteTemplates =
    config.mode === 'same-cap-image' &&
    obsoleteTemplates.length > 0 &&
    obsoleteTemplates.every((change) => sameActions(change, ['delete']))
  if (
    !template ||
    !manager ||
    changes.length !== 2 + obsoleteTemplates.length ||
    (obsoleteTemplates.length > 0 && !allowsObsoleteTemplates)
  ) {
    throw new Error('cell plan must change only the exact instance template and MIG')
  }
  if (!sameActions(template, ['create', 'delete']) || !sameActions(manager, ['update'])) {
    throw new Error('cell plan has unexpected replacement actions')
  }
  const templateComputed = new Set([
    'confidential_instance_config',
    'creation_timestamp',
    'disk.0.architecture',
    'disk.0.interface',
    'disk.0.mode',
    'disk.0.provisioned_iops',
    'disk.0.provisioned_throughput',
    'disk.0.type',
    'id',
    'metadata_fingerprint',
    'name',
    'network_interface.0.internal_ipv6_prefix_length',
    'network_interface.0.ipv6_access_type',
    'network_interface.0.ipv6_address',
    'network_interface.0.name',
    'network_interface.0.network',
    'network_interface.0.stack_type',
    'network_interface.0.subnetwork_project',
    'numeric_id',
    'region',
    'self_link',
    'self_link_unique',
    'tags_fingerprint'
  ])
  const templateDefaults = [
    'description',
    'disk.0.disk_name',
    'disk.0.guest_os_features',
    'disk.0.labels',
    'disk.0.resource_manager_tags',
    'disk.0.resource_policies',
    'disk.0.source',
    'disk.0.source_snapshot',
    'instance_description',
    'key_revocation_action_type',
    'min_cpu_platform',
    'network_interface.0.network_ip',
    'network_interface.0.nic_type',
    'network_interface.0.queue_count',
    'scheduling.0.availability_domain',
    'scheduling.0.instance_termination_action',
    'scheduling.0.min_node_cpus',
    'scheduling.0.termination_time'
  ]
  const templateCanonicalResources = [
    'disk.0.source_image',
    'network_interface.0.subnetwork'
  ]
  const templateUnknown = unknownPaths(template.change.after_unknown)
  requireOnlyPaths(
    template,
    new Set([
      'metadata_startup_script',
      ...templateUnknown.filter((path) => templateComputed.has(path)),
      ...providerDefaultPaths(template, templateDefaults),
      ...canonicalResourcePaths(template, templateCanonicalResources)
    ]),
    ['metadata_startup_script'],
    templateComputed
  )
  validateManagerUpdate(manager, config)
  requireReplacementTemplateDependency(plan, template, manager)
  const beforeScript = template.change.before?.metadata_startup_script
  const script = template.change.after?.metadata_startup_script
  requireDesiredStartupScript(script, config)
  const sameCap = ['same-cap-cell', 'same-cap-image'].includes(config.mode)
  if (
    typeof beforeScript !== 'string' ||
    (sameCap && relayImage(beforeScript) !== config.rollbackImage) ||
    normalizedStartupScript(
      beforeScript,
      config.mode === 'bootstrap-cell',
      config.mode === 'same-cap-cell',
      sameCap
    ) !== normalizedStartupScript(
      script,
      config.mode === 'bootstrap-cell',
      config.mode === 'same-cap-cell',
      sameCap
    )
  ) {
    throw new Error('cell plan does not contain the reviewed image and capacity')
  }
}

function convergenceCellPlan(plan, changes, config) {
  const templateAddress = `google_compute_instance_template.relay_gce_cell[${JSON.stringify(config.cellId)}]`
  const managerAddress = `google_compute_instance_group_manager.relay_gce_cell[${JSON.stringify(config.cellId)}]`
  const manager = changes.find(({ address }) => address === managerAddress)
  const obsoleteTemplates = changes.filter(
    ({ address, deposed }) => address === templateAddress && typeof deposed === 'string'
  )
  if (
    (!manager && obsoleteTemplates.length === 0) ||
    (obsoleteTemplates.length > 1 && config.mode !== 'same-cap-image') ||
    changes.length !== (manager ? 1 : 0) + obsoleteTemplates.length
  ) {
    throw new Error('cell convergence plan changes outside the exact template and MIG')
  }
  if (manager) validateManagerUpdate(manager, config)
  if (obsoleteTemplates.some((change) => !sameActions(change, ['delete']))) {
    throw new Error('cell convergence plan has unexpected obsolete-template actions')
  }
  requireDesiredPlannedCell(plan, config)
}

export function validateCapacityPlan(plan, config) {
  if (!['cell', 'bootstrap-cell', 'same-cap-cell', 'same-cap-image'].includes(config.mode)) {
    throw new Error('capacity Terraform plans may change only a cell')
  }
  if (
    config.mode === 'bootstrap-cell' &&
    !SERVICE_ACCOUNT_EMAIL.test(config.capacityServiceAccount ?? '')
  ) {
    throw new Error('capacity Terraform plan has an invalid service account')
  }
  if (
    config.mode === 'same-cap-cell' &&
    (!SERVICE_ACCOUNT_EMAIL.test(config.rehomeDirectorServiceAccount ?? '') ||
      !/^https:\/\/[^/]+\/v1\/admin\/host-drain$/.test(config.rehomeAudience ?? '') ||
      !/^.+@sha256:[a-f0-9]{64}$/.test(config.rollbackImage ?? ''))
  ) throw new Error('same-cap Terraform plan has invalid rehome trust config')
  if (
    config.mode === 'same-cap-image' &&
    !/^.+@sha256:[a-f0-9]{64}$/.test(config.rollbackImage ?? '')
  ) throw new Error('same-cap image Terraform plan has an invalid rollback image')
  const changes = mutations(plan)
  if (changes.length === 0) {
    return {
      mode: config.mode,
      changes: 0,
      ...(config.mode === 'same-cap-image' ? { changeKind: 'none' } : {})
    }
  }
  const replacement = changes.some(
    ({ address, deposed, change }) =>
      address === `google_compute_instance_template.relay_gce_cell[${JSON.stringify(config.cellId)}]` &&
      deposed === undefined &&
      JSON.stringify(change?.actions) === JSON.stringify(['create', 'delete'])
  )
  if (replacement) cellPlan(plan, changes, config)
  else convergenceCellPlan(plan, changes, config)
  const obsoleteTemplateOnly = changes.every(
    ({ address, deposed, change }) =>
      address === `google_compute_instance_template.relay_gce_cell[${JSON.stringify(config.cellId)}]` &&
      typeof deposed === 'string' &&
      JSON.stringify(change?.actions) === JSON.stringify(['delete'])
  )
  return {
    mode: config.mode,
    changes: changes.length,
    ...(config.mode === 'same-cap-image'
      ? {
          changeKind: replacement
            ? changes.some(
                ({ address, deposed }) =>
                  address === `google_compute_instance_template.relay_gce_cell[${JSON.stringify(config.cellId)}]` &&
                  typeof deposed === 'string'
              )
              ? 'replacement-with-obsolete-template'
              : 'replacement'
            : obsoleteTemplateOnly
              ? 'obsolete-template-delete'
              : 'manager-convergence'
        }
      : {})
  }
}

export function main(argv = process.argv.slice(2)) {
  const config = parseArguments(argv)
  const plan = JSON.parse(readFileSync(0, 'utf8'))
  process.stdout.write(`${JSON.stringify({ event: 'relay_capacity_plan_verified', ...validateCapacityPlan(plan, config) })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
