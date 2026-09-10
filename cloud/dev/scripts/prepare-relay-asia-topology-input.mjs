import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BOOT_IMAGE = 'https://www.googleapis.com/compute/v1/projects/cos-cloud/global/images/cos-stable-121-18867-528-21'
const SHAPES = {
  staging: { project: 'onorca-cloud-staging', cells: { 'staging-gce-c4': 'asia-east2-a' } },
  production: {
    project: 'onorca-cloud',
    cells: {
      'production-gce-c27': 'asia-east2-a',
      'production-gce-c28': 'asia-east2-b',
      'production-gce-c29': 'asia-east2-c'
    }
  }
}

function argumentsFrom(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['existing-json', 'environment', 'cell-ids', 'image']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  return values
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

export function prepareRelayAsiaTopologyInput({
  existingCells,
  existingAdditionalRegions,
  environment,
  cellIds,
  image
}) {
  const shape = SHAPES[environment]
  if (!shape) throw new Error('invalid environment')
  const requested = cellIds.split(',').map((value) => value.trim()).filter(Boolean).sort()
  const expected = Object.keys(shape.cells).sort()
  if (new Set(requested).size !== requested.length || JSON.stringify(requested) !== JSON.stringify(expected)) {
    throw new Error('cell IDs do not match the reviewed Asia topology')
  }
  const prefix = `us-central1-docker.pkg.dev/${shape.project}/orca-cloud/relay@sha256:`
  if (!image.startsWith(prefix) || !/sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('image is not the environment Relay image pinned by digest')
  }
  if (!existingCells || Array.isArray(existingCells) || typeof existingCells !== 'object') {
    throw new Error('existing Relay cells must be an object')
  }
  if (
    !existingAdditionalRegions ||
    Array.isArray(existingAdditionalRegions) ||
    typeof existingAdditionalRegions !== 'object' ||
    JSON.stringify(canonical(existingAdditionalRegions)) !==
      JSON.stringify(canonical({ 'asia-east2': '10.42.1.0/24' }))
  ) {
    throw new Error('Asia subnet must be committed before topology planning')
  }
  const additions = Object.fromEntries(expected.map((cellId) => {
    const hostname = cellId.split('-').at(-1)
    return [cellId, {
      hostname,
      region: 'asia-east2',
      zone: shape.cells[cellId],
      machine_type: 'e2-standard-4',
      boot_disk_gb: 30,
      boot_image: BOOT_IMAGE,
      capacity_requests: 6_000,
      database_pool_max: 10,
      image,
      initially_enabled: false,
      connection_hard_cap: 3_000,
      connection_unobserved_bound: 60
    }]
  }))
  for (const cellId of expected) {
    if (!existingCells[cellId]) {
      throw new Error('Asia cells must be committed before topology planning')
    }
    if (
      JSON.stringify(canonical(existingCells[cellId])) !==
      JSON.stringify(canonical(additions[cellId]))
    ) {
      throw new Error('committed Asia cell differs from the reviewed topology')
    }
  }
  return {
    relay_gce_additional_region_subnetwork_cidrs: existingAdditionalRegions,
    relay_gce_cells: existingCells
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const values = argumentsFrom(process.argv.slice(2))
  const existing = JSON.parse(readFileSync(values['existing-json'], 'utf8'))
  prepareRelayAsiaTopologyInput({
    existingCells: existing.relay_gce_cells,
    existingAdditionalRegions: existing.relay_gce_additional_region_subnetwork_cidrs,
    environment: values.environment,
    cellIds: values['cell-ids'],
    image: values.image
  })
}
