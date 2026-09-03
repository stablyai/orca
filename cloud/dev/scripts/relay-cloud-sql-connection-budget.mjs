import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DEFAULT_PATHS = {
  productionTfvars: new URL('../../infra/terraform/environments/production.tfvars', import.meta.url),
  terraformVariables: new URL('../../infra/terraform/variables.tf', import.meta.url),
  relayConfig: new URL('../../apps/relay/src/config.ts', import.meta.url)
}

// Auth and API live outside the Relay tree, so their consumption is published as a contract
// rather than parsed from their source. production-cloud-sql-app-consumers.test.mjs binds it back.
const APP_CONSUMERS_CONTRACT = new URL(
  '../contracts/production-cloud-sql-app-consumers.json',
  import.meta.url
)

const APP_CONSUMER_FIELDS = ['authInstances', 'authPoolMax', 'apiInstances', 'apiPoolMax', 'maxConnections']

export function readProductionCloudSqlAppConsumers(contract) {
  const parsed = contract ?? JSON.parse(readFileSync(APP_CONSUMERS_CONTRACT, 'utf8'))
  for (const field of APP_CONSUMER_FIELDS) {
    const value = parsed[field]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`could not read ${field} from the app consumer contract`)
    }
  }
  return parsed
}

function requiredInteger(source, pattern, label) {
  const value = Number(source.match(pattern)?.[1])
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`could not read ${label}`)
  return value
}

function productionCells(source, defaultPoolMax) {
  const fencedMatch = source.match(/relay_gce_fenced_cells\s*=\s*\[([^\]]*)\]/)
  if (!fencedMatch) throw new Error('could not read fenced Relay cells')
  const fenced = new Set([...fencedMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]))
  const cells = [...source.matchAll(/"(production-gce-[^"]+)"\s*=\s*\{([\s\S]*?)\n\s*\}/g)].map(
    ([, id, body]) => ({
      id,
      fenced: fenced.has(id),
      region: body.match(/\bregion\s*=\s*"([^"]+)"/)?.[1] ?? 'us-central1',
      poolMax: body.match(/\bdatabase_pool_max\s*=\s*(\d+)/)
        ? Number(body.match(/\bdatabase_pool_max\s*=\s*(\d+)/)[1])
        : defaultPoolMax
    })
  )
  if (cells.length === 0) throw new Error('could not read production Relay cells')
  return cells
}

export function calculateRelayCloudSqlConnectionBudget(inputs) {
  const consumers = {
    cells: inputs.cellPoolTotal + inputs.asiaCellCount * inputs.asiaPoolMax,
    directors: inputs.directorInstances * inputs.directorPoolMax,
    auth: inputs.authInstances * inputs.authPoolMax,
    api: inputs.apiInstances * inputs.apiPoolMax
  }
  const configuredMaximum = Object.values(consumers).reduce((total, value) => total + value, 0)
  const retainedDirectorRollback = inputs.directorInstances * inputs.directorPoolMax
  const candidateOverlap = {
    relayDirectorCandidate: retainedDirectorRollback * 2,
    apiCandidate: retainedDirectorRollback + inputs.apiInstances * inputs.apiPoolMax,
    authCandidate: retainedDirectorRollback + inputs.authInstances * inputs.authPoolMax,
    relayCells: retainedDirectorRollback
  }
  const rolloutOverlap = Math.max(...Object.values(candidateOverlap))
  const operatingMaximum = configuredMaximum + rolloutOverlap + inputs.maintenanceAdminAllowance
  const usableCeiling = inputs.maxConnections - inputs.explicitReserve
  const budgetedTotal = operatingMaximum + inputs.explicitReserve
  return {
    maxConnections: inputs.maxConnections,
    consumers,
    asia: { cells: inputs.asiaCellCount, poolMax: inputs.asiaPoolMax },
    configuredMaximum,
    rolloutOverlap: {
      ...candidateOverlap,
      retainedDirectorRollback,
      maximum: rolloutOverlap,
      reason: 'serialized rollouts include directly addressable tagged revisions outside service-level caps'
    },
    maintenanceAdminAllowance: inputs.maintenanceAdminAllowance,
    maintenanceAdminAllowanceReason: 'covers bounded work outside configured services',
    explicitReserve: inputs.explicitReserve,
    explicitReserveReason: 'remains unavailable to configured services and planned rollouts',
    usableCeiling,
    operatingMaximum,
    remainingWithinUsableCeiling: usableCeiling - operatingMaximum,
    budgetedTotal,
    unallocated: inputs.maxConnections - budgetedTotal,
    withinBudget: operatingMaximum <= usableCeiling && budgetedTotal < inputs.maxConnections
  }
}

export function readRelayCloudSqlConnectionBudget({
  sources,
  appConsumers,
  proposedAsiaCellCount = 3,
  asiaPoolMax = 10,
  maxConnections,
  maintenanceAdminAllowance = 5,
  explicitReserve = 10
} = {}) {
  const read = (name) => sources?.[name] ?? readFileSync(DEFAULT_PATHS[name], 'utf8')
  const apps = readProductionCloudSqlAppConsumers(appConsumers)
  const productionTfvars = read('productionTfvars')
  const terraformVariables = read('terraformVariables')
  const relayConfig = read('relayConfig')
  const cells = productionCells(
    productionTfvars,
    requiredInteger(relayConfig, /RELAY_DATABASE_POOL_MAX\s*=\s*(\d+)/, 'Relay pool maximum')
  )
  const poweredCells = cells.filter(({ fenced }) => !fenced)
  const configuredAsiaCells = poweredCells.filter(({ region }) => region === 'asia-east2')
  const nonAsiaCells = poweredCells.filter(({ region }) => region !== 'asia-east2')
  const cellPoolTotal = nonAsiaCells.reduce((total, cell) => total + cell.poolMax, 0)
  const asiaCellCount = configuredAsiaCells.length || proposedAsiaCellCount
  const configuredAsiaPoolMax = configuredAsiaCells[0]?.poolMax ?? asiaPoolMax
  if (configuredAsiaCells.some(({ poolMax }) => poolMax !== configuredAsiaPoolMax)) {
    throw new Error('Asia Relay cells must use one checked pool maximum')
  }
  return calculateRelayCloudSqlConnectionBudget({
    cellPoolTotal,
    asiaCellCount,
    asiaPoolMax: configuredAsiaPoolMax,
    directorInstances: requiredInteger(productionTfvars, /relay_max_instances\s*=\s*(\d+)/, 'director instances'),
    directorPoolMax: requiredInteger(
      terraformVariables,
      /variable\s+"relay_director_database_pool_max"[\s\S]*?default\s*=\s*(\d+)/,
      'director pool maximum'
    ),
    authInstances: apps.authInstances,
    authPoolMax: apps.authPoolMax,
    apiInstances: apps.apiInstances,
    apiPoolMax: apps.apiPoolMax,
    maxConnections: maxConnections ?? apps.maxConnections,
    maintenanceAdminAllowance,
    explicitReserve
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = readRelayCloudSqlConnectionBudget()
  console.log(JSON.stringify({ event: 'relay_cloud_sql_connection_budget', ...report }, null, 2))
  if (!report.withinBudget) process.exitCode = 1
}
