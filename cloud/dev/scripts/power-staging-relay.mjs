import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import {
  inspectAdmissionSelector,
  selectorCellState
} from './relay-admission-selector.mjs'

const PROJECT = 'onorca-cloud-staging'
const REGION = 'us-central1'
const DIRECTOR_ORIGIN = 'https://relay-staging.onorca.dev'
const ADMIN_AUDIENCE = `${DIRECTOR_ORIGIN}/v1/admin/drain`
const SQL_INSTANCE = 'orca-cloud-staging-auth-db'
const CLOUD_RUN_SERVICES = [
  { name: 'orca-cloud-relay-staging', healthOrigin: DIRECTOR_ORIGIN },
  { name: 'orca-cloud-auth-staging', healthOrigin: 'https://auth-staging.onorca.dev' }
]
const POLL_INTERVAL_MS = 5_000
const WAKE_TIMEOUT_MS = 12 * 60 * 1_000

export function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument ${key ?? ''}`)
    const name = key.slice(2)
    if (!['mode', 'wake-cells', 'topology-file'].includes(name)) {
      throw new Error(`unsupported argument --${name}`)
    }
    values[name] = value
  }
  if (!['status', 'sleep', 'wake'].includes(values.mode)) {
    throw new Error('--mode must be status, sleep, or wake')
  }
  if (!['configured', 'all'].includes(values['wake-cells'])) {
    throw new Error('--wake-cells must be configured or all')
  }
  if (!values['topology-file']) throw new Error('missing --topology-file')
  return {
    mode: values.mode,
    wakeCells: values['wake-cells'],
    topologyFile: values['topology-file']
  }
}

function canonicalStagingCell(cellId, value) {
  if (!/^staging-gce-[a-z0-9-]+$/.test(cellId)) throw new Error(`unsafe staging cell ID ${cellId}`)
  if (!value || typeof value !== 'object') throw new Error(`missing topology for ${cellId}`)
  const cell = {
    cellId,
    migName: String(value.mig_name ?? ''),
    zone: String(value.zone ?? ''),
    origin: String(value.origin ?? ''),
    initiallyEnabled: value.initially_enabled
  }
  if (!/^orca-cloud-staging-relay-gce-[a-z0-9-]+$/.test(cell.migName)) {
    throw new Error(`${cellId} has an unsafe MIG name`)
  }
  if (!/^(?:us-central1|asia-east2)-[a-z]$/.test(cell.zone)) {
    throw new Error(`${cellId} has an unsafe zone`)
  }
  const origin = new URL(cell.origin)
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== cell.origin ||
    !origin.hostname.endsWith('.relay-staging.onorca.dev')
  ) {
    throw new Error(`${cellId} has an unsafe origin`)
  }
  if (typeof cell.initiallyEnabled !== 'boolean') {
    throw new Error(`${cellId} has no initial admission state`)
  }
  return cell
}

export function readStagingTopology(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('staging topology must be an object')
  }
  const cells = Object.entries(parsed)
    .map(([cellId, value]) => canonicalStagingCell(cellId, value))
    .sort((left, right) => left.cellId.localeCompare(right.cellId))
  if (cells.length < 2 || cells.length > 10) {
    throw new Error('staging topology must contain 2..10 cells')
  }
  if (cells.filter((cell) => cell.initiallyEnabled).length < 2) {
    throw new Error('staging topology must retain two configured admission cells')
  }
  return cells
}

function defaultCommand(args, json) {
  const result = spawnSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (result.status !== 0) {
    throw new Error(`gcloud ${args.slice(0, 5).join(' ')} failed: ${result.stderr.trim()}`)
  }
  return json ? JSON.parse(result.stdout) : result.stdout.trim()
}

function suppliedAdminToken(environment = process.env) {
  const token = environment.ORCA_RELAY_ADMIN_ID_TOKEN
  if (!token || token.length > 8_192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('workflow did not supply a valid masked staging admin token')
  }
  return token
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => ({ error: `http_${response.status}` }))
  if (!response.ok) throw new Error(`${label} failed: ${body.error ?? response.status}`)
  return body
}

function createAdminPost(deps) {
  const token = deps.adminToken()
  return async (origin, path, body) =>
    await responseJson(
      await deps.fetch(`${origin}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000)
      }),
      path
    )
}

async function waitUntil(deps, label, operation, timeoutMs = WAKE_TIMEOUT_MS) {
  const deadline = deps.now() + timeoutMs
  let lastError
  while (deps.now() < deadline) {
    try {
      const result = await operation()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await deps.wait(POLL_INTERVAL_MS)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${label}${detail}`)
}

async function checkHealth(deps, origin, path) {
  const response = await deps.fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000) })
  const body = await response.json().catch(() => ({}))
  return response.ok && body.ok === true
}

function sqlActivationPolicy(instance) {
  return String(instance.settings?.activationPolicy ?? '')
}

function describeSql(deps) {
  return deps.commandJson([
    'sql',
    'instances',
    'describe',
    SQL_INSTANCE,
    '--project',
    PROJECT,
    '--format=json'
  ])
}

async function ensureSqlPolicy(deps, policy) {
  if (sqlActivationPolicy(describeSql(deps)) === policy) return false
  deps.command([
    'sql',
    'instances',
    'patch',
    SQL_INSTANCE,
    '--project',
    PROJECT,
    `--activation-policy=${policy}`,
    '--quiet'
  ])
  await waitUntil(deps, `Cloud SQL activation policy ${policy}`, () =>
    sqlActivationPolicy(describeSql(deps)) === policy
  )
  return true
}

function describeMig(deps, cell) {
  return deps.commandJson([
    'compute',
    'instance-groups',
    'managed',
    'describe',
    cell.migName,
    '--project',
    PROJECT,
    '--zone',
    cell.zone,
    '--format=json'
  ])
}

async function setMigSize(deps, cell, size) {
  const before = describeMig(deps, cell)
  if (Number(before.targetSize) !== size) {
    deps.command([
      'compute',
      'instance-groups',
      'managed',
      'resize',
      cell.migName,
      '--project',
      PROJECT,
      '--zone',
      cell.zone,
      `--size=${size}`,
      '--quiet'
    ])
  }
  await waitUntil(deps, `${cell.cellId} size ${size}`, () => {
    const current = describeMig(deps, cell)
    return Number(current.targetSize) === size && current.status?.isStable === true
  })
}

function activeRevisionName(service) {
  const active = (service.status?.traffic ?? []).filter((entry) => Number(entry.percent ?? 0) > 0)
  if (active.length !== 1 || Number(active[0].percent) !== 100 || !active[0].revisionName) {
    throw new Error('Cloud Run service must have exactly one active revision')
  }
  return active[0].revisionName
}

function describeRunService(deps, name) {
  return deps.commandJson([
    'run',
    'services',
    'describe',
    name,
    '--project',
    PROJECT,
    '--region',
    REGION,
    '--format=json'
  ])
}

function describeRunRevision(deps, name) {
  return deps.commandJson([
    'run',
    'revisions',
    'describe',
    name,
    '--project',
    PROJECT,
    '--region',
    REGION,
    '--format=json'
  ])
}

function revisionMinimum(revision) {
  return Number(revision.metadata?.annotations?.['autoscaling.knative.dev/minScale'] ?? 0)
}

async function ensureCloudRunScaleToZero(deps, service) {
  const before = describeRunService(deps, service.name)
  const activeRevision = describeRunRevision(deps, activeRevisionName(before))
  if (revisionMinimum(activeRevision) === 0) return false

  const latestName = before.status?.latestReadyRevisionName
  const latest = latestName ? describeRunRevision(deps, latestName) : null
  if (!latest || revisionMinimum(latest) !== 0) {
    deps.command([
      'run',
      'services',
      'update',
      service.name,
      '--project',
      PROJECT,
      '--region',
      REGION,
      '--min-instances=0',
      '--quiet'
    ])
  }
  deps.command([
    'run',
    'services',
    'update-traffic',
    service.name,
    '--project',
    PROJECT,
    '--region',
    REGION,
    '--to-latest',
    '--quiet'
  ])
  await waitUntil(deps, `${service.name} scale-to-zero revision`, async () => {
    const current = describeRunService(deps, service.name)
    const revision = describeRunRevision(deps, activeRevisionName(current))
    return revisionMinimum(revision) === 0 && (await checkHealth(deps, service.healthOrigin, '/health'))
  })
  return true
}

async function cellStatus(adminPost, cell) {
  const response = await adminPost(DIRECTOR_ORIGIN, '/v1/admin/cell-status', {
    v: 1,
    cellId: cell.cellId
  })
  if (!response.status || response.status.cellId !== cell.cellId) {
    throw new Error(`${cell.cellId} returned an invalid status`)
  }
  return response.status
}

function assertQuiescent(status) {
  const active = {
    activityLeases: status.activityLeases,
    activityRequestUnits: status.activityRequestUnits,
    outgoingMigrations: status.outgoingMigrations,
    incomingMigrations: status.incomingMigrations,
    observedRequests: status.runtime?.observedRequests ?? 0
  }
  if (Object.values(active).some((value) => Number(value) !== 0)) {
    throw new Error(`${status.cellId} still has active Relay work: ${JSON.stringify(active)}`)
  }
}

async function setCellState(adminPost, cell, enabled) {
  await adminPost(DIRECTOR_ORIGIN, '/v1/admin/cell-state', {
    v: 1,
    cellId: cell.cellId,
    enabled
  })
}

async function stagingStatus(deps, cells) {
  return {
    event: 'staging_relay_power_status',
    project: PROJECT,
    sqlActivationPolicy: sqlActivationPolicy(describeSql(deps)),
    cells: cells.map((cell) => ({
      cellId: cell.cellId,
      initiallyEnabled: cell.initiallyEnabled,
      targetSize: Number(describeMig(deps, cell).targetSize)
    })),
    cloudRun: CLOUD_RUN_SERVICES.map((service) => {
      const described = describeRunService(deps, service.name)
      const revision = describeRunRevision(deps, activeRevisionName(described))
      return { service: service.name, activeRevisionMinimum: revisionMinimum(revision) }
    })
  }
}

async function sleepStaging(deps, cells) {
  const sqlPolicy = sqlActivationPolicy(describeSql(deps))
  if (sqlPolicy === 'NEVER') {
    const runningCells = cells.filter((cell) => Number(describeMig(deps, cell).targetSize) !== 0)
    if (runningCells.length > 0) {
      // SQL-off plus running workers is an unknown partial state; never kill those workers blindly.
      throw new Error(
        `staging is partially asleep with running cells: ${runningCells.map((cell) => cell.cellId).join(', ')}`
      )
    }
    deps.emit({ event: 'staging_relay_sleep_reconciled', alreadyAsleep: true })
    return
  }

  const adminPost = createAdminPost(deps)
  const initial = await Promise.all(cells.map((cell) => cellStatus(adminPost, cell)))
  for (const status of initial) assertQuiescent(status)
  const selector = await inspectAdmissionSelector(
    async (path, body) => await adminPost(DIRECTOR_ORIGIN, path, body)
  )
  if (selector.selector.generation > 0) {
    throw new Error(
      'staging sleep cannot reverse the monotonic admission selector; keep staging awake'
    )
  }
  const previouslyEnabled = new Set(initial.filter((status) => status.enabled).map((status) => status.cellId))

  for (const cell of cells) await setCellState(adminPost, cell, false)
  await deps.wait(15_000)
  try {
    const disabled = await Promise.all(cells.map((cell) => cellStatus(adminPost, cell)))
    for (const status of disabled) {
      if (status.enabled) throw new Error(`${status.cellId} admission did not disable`)
      assertQuiescent(status)
    }
    for (const service of CLOUD_RUN_SERVICES) await ensureCloudRunScaleToZero(deps, service)
    const final = await Promise.all(cells.map((cell) => cellStatus(adminPost, cell)))
    for (const status of final) assertQuiescent(status)
  } catch (error) {
    for (const cell of cells.filter((candidate) => previouslyEnabled.has(candidate.cellId))) {
      await setCellState(adminPost, cell, true).catch(() => undefined)
    }
    throw error
  }

  await Promise.all(cells.map((cell) => setMigSize(deps, cell, 0)))
  await ensureSqlPolicy(deps, 'NEVER')
  deps.emit({ event: 'staging_relay_slept', stoppedCells: cells.map((cell) => cell.cellId) })
}

async function wakeStaging(deps, cells, wakeCells) {
  await ensureSqlPolicy(deps, 'ALWAYS')
  await waitUntil(deps, 'staging director health', () => checkHealth(deps, DIRECTOR_ORIGIN, '/health'))
  for (const service of CLOUD_RUN_SERVICES) await ensureCloudRunScaleToZero(deps, service)

  const adminPost = createAdminPost(deps)
  const selector = await inspectAdmissionSelector(
    async (path, body) => await adminPost(DIRECTOR_ORIGIN, path, body)
  )
  const selectorActive = selector.selector.generation > 0
  // Existing-only cells may still own live or dormant assignments, so a
  // selector-era wake restores the complete retained topology.
  const selected = selectorActive
    ? cells
    : cells.filter((cell) => wakeCells === 'all' || cell.initiallyEnabled)
  await Promise.all(
    cells.map((cell) => setMigSize(deps, cell, selected.includes(cell) ? 1 : 0))
  )
  for (const cell of selected) {
    await waitUntil(deps, `${cell.cellId} health`, () => checkHealth(deps, cell.origin, '/health'))
    await waitUntil(deps, `${cell.cellId} readiness`, () => checkHealth(deps, cell.origin, '/ready'))
  }

  for (const cell of cells) {
    if (selectorActive) {
      const status = await waitUntil(deps, `${cell.cellId} authenticated heartbeat`, async () => {
        const current = await cellStatus(adminPost, cell)
        return current.runtime?.heartbeatFresh && current.runtime.ready ? current : null
      })
      if (status.admissionState !== selectorCellState(selector.selector, cell.cellId)) {
        throw new Error(`${cell.cellId} admission does not match selector`)
      }
      continue
    }
    if (!selected.includes(cell)) {
      await setCellState(adminPost, cell, false)
      continue
    }
    const status = await waitUntil(deps, `${cell.cellId} authenticated heartbeat`, async () => {
      const current = await cellStatus(adminPost, cell)
      return current.runtime?.heartbeatFresh && current.runtime.ready ? current : null
    })
    if (cell.initiallyEnabled && !status.enabled) await setCellState(adminPost, cell, true)
    if (!cell.initiallyEnabled && status.enabled) await setCellState(adminPost, cell, false)
  }
  deps.emit({
    event: 'staging_relay_woke',
    runningCells: selected.map((cell) => cell.cellId),
    admissionCells: selectorActive
      ? selector.selector.membership.general
      : selected.filter((cell) => cell.initiallyEnabled).map((cell) => cell.cellId)
  })
}

export async function runStagingRelayPower(config, overrides = {}) {
  const deps = {
    command: overrides.command ?? ((args) => defaultCommand(args, false)),
    commandJson: overrides.commandJson ?? ((args) => defaultCommand(args, true)),
    fetch: overrides.fetch ?? fetch,
    adminToken: overrides.adminToken ?? suppliedAdminToken,
    emit: overrides.emit ?? ((event) => process.stdout.write(`${JSON.stringify(event)}\n`)),
    now: overrides.now ?? Date.now,
    wait: overrides.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }
  const cells = readStagingTopology(config.topologyFile)
  if (config.mode === 'status') deps.emit(await stagingStatus(deps, cells))
  else if (config.mode === 'sleep') await sleepStaging(deps, cells)
  else await wakeStaging(deps, cells, config.wakeCells)
}

export async function main(argv = process.argv.slice(2)) {
  await runStagingRelayPower(parseArguments(argv))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
