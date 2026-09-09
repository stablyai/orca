import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const POLL_INTERVAL_MS = 5_000
const MIGRATION_TIMEOUT_MS = 14 * 60 * 1000
const CONNECTION_CAPACITY_PROTOCOL = 2
export const DIRECTOR_REGIONAL_PLACEMENT_SECRET =
  'orca-cloud-relay-regional-placement-enabled'
export const DIRECTOR_REGIONAL_PLACEMENT_ENV =
  'ORCA_RELAY_REGIONAL_PLACEMENT_ENABLED'
export const DIRECTOR_REHOME_IDENTITY_ENV =
  'ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT'
export const DIRECTOR_REHOME_AUDIENCE_ENV = 'ORCA_RELAY_REHOME_AUDIENCE'
export const SELECTOR_ROLLBACK_TAG = 'selector-rollback'
export const SELECTOR_REVISION_MARKER = '3'
export const DIRECTOR_ADMISSION_ENVIRONMENT = Object.freeze({
  ORCA_RELAY_DATABASE_POOL_MAX: '3',
  ORCA_RELAY_PUBLIC_ASSIGNMENT_CONCURRENCY: '2',
  ORCA_RELAY_PUBLIC_ASSIGNMENT_QUEUE_MAX: '128',
  ORCA_RELAY_PUBLIC_ASSIGNMENT_RETRY_AFTER_SECONDS: '5',
  ORCA_RELAY_PUBLIC_ASSIGNMENT_WAIT_MS: '4000'
})
const DIRECTOR_STARTUP_PROBE =
  'tcpSocket.port=8080,timeoutSeconds=120,periodSeconds=120,failureThreshold=1'

export function taggedRevisionOrigin(serviceOrigin, tag) {
  const url = new URL(serviceOrigin)
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname.endsWith('.run.app')
  ) {
    throw new Error('Cloud Run service origin is not canonical')
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(tag)) throw new Error('invalid Cloud Run tag')
  return `https://${tag}---${url.hostname}`
}

export function activeRevision(service) {
  const active = (service.status?.traffic ?? []).filter((entry) => Number(entry.percent ?? 0) > 0)
  if (active.length !== 1 || Number(active[0].percent) !== 100 || !active[0].revisionName) {
    throw new Error('relay service must have exactly one revision receiving 100% traffic')
  }
  return active[0].revisionName
}

export function trafficTags(service) {
  return (service.status?.traffic ?? [])
    .map((entry) => entry.tag)
    .filter((tag) => typeof tag === 'string')
}

export function taggedTraffic(service, tag) {
  const traffic = (service.status?.traffic ?? []).find((entry) => entry.tag === tag)
  if (!traffic?.url || !traffic.revisionName) throw new Error(`Cloud Run tag ${tag} is not ready`)
  return { origin: traffic.url, revision: traffic.revisionName }
}

export function revisionEnvironment(revision) {
  const entries = revision.spec?.containers?.[0]?.env ?? []
  return Object.fromEntries(
    entries
      .filter((entry) => entry.name && 'value' in entry)
      .map((entry) => [entry.name, entry.value])
  )
}

export function revisionSecretEnvironment(revision) {
  const entries = revision.spec?.containers?.[0]?.env ?? []
  return Object.fromEntries(
    entries
      .map((entry) => {
        const reference = entry.valueSource?.secretKeyRef ?? entry.valueFrom?.secretKeyRef
        return [entry.name, reference && {
          secret: reference.secret ?? reference.name,
          version: reference.version ?? reference.key
        }]
      })
      .filter(([name, reference]) => name && reference)
  )
}

export function revisionMinimumInstances(revision) {
  return Number(revision.metadata?.annotations?.['autoscaling.knative.dev/minScale'] ?? 0)
}

export function revisionMaximumInstances(revision) {
  const value = Number(revision.metadata?.annotations?.['autoscaling.knative.dev/maxScale'])
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('serving revision has no bounded maximum instance count')
  }
  return value
}

function hasExpectedEnvironment(environment, expected) {
  return Object.entries(expected).every(([key, value]) => environment[key] === value)
}

function projectServiceAccount(config, argument) {
  const value = config[argument]
  if (value === undefined) return undefined
  const suffix = `@${config.project}.iam.gserviceaccount.com`
  const account = value.endsWith(suffix) ? value.slice(0, -suffix.length) : ''
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(account)) {
    throw new Error(`--${argument} must belong to the selected project`)
  }
  return value
}

function directorCellsJson(value, { allowMissingRegion = false } = {}) {
  if (value === undefined) return undefined
  if (value.length > 100_000 || /[\r\n]/.test(value)) {
    throw new Error('--director-cells-json is invalid')
  }
  const cells = JSON.parse(value)
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > 100) {
    throw new Error('--director-cells-json must contain 1..100 cells')
  }
  const ids = new Set()
  for (const cell of cells) {
    const keys = Object.keys(cell ?? {}).sort()
    const expectedKeys = [
      'capacityRequests',
      'id',
      'initiallyEnabled',
      ...(allowMissingRegion && cell?.region === undefined ? [] : ['region']),
      'url',
      ...(cell?.connectionHardCap === undefined
        ? []
        : ['connectionHardCap', 'connectionUnobservedBound'])
    ].sort()
    let origin
    try {
      origin = new URL(cell?.url)
    } catch {
      throw new Error('--director-cells-json contains an invalid cell URL')
    }
    const cap = cell?.connectionHardCap
    const bound = cell?.connectionUnobservedBound
    if (
      JSON.stringify(keys) !== JSON.stringify(expectedKeys) ||
      !/^[a-z][a-z0-9-]{0,39}$/.test(cell.id ?? '') ||
      ids.has(cell.id) ||
      origin.protocol !== 'https:' ||
      origin.origin !== cell.url ||
      !Number.isSafeInteger(cell.capacityRequests) ||
      cell.capacityRequests < 1 ||
      !['us-central1', 'asia-east2'].includes(
        cell.region ?? (allowMissingRegion ? 'us-central1' : undefined)
      ) ||
      typeof cell.initiallyEnabled !== 'boolean' ||
      (cap !== undefined &&
        (![600, 1_000, 3_000].includes(cap) ||
          !Number.isSafeInteger(bound) ||
          bound < 0 ||
          bound >= cap - 100))
    ) {
      throw new Error('--director-cells-json contains an invalid cell')
    }
    ids.add(cell.id)
  }
  return JSON.stringify(
    cells.map((cell) => ({
      id: cell.id,
      url: cell.url,
      capacityRequests: cell.capacityRequests,
      region: cell.region ?? 'us-central1',
      initiallyEnabled: cell.initiallyEnabled,
      ...(cell.connectionHardCap === undefined
        ? {}
        : {
            connectionHardCap: cell.connectionHardCap,
            connectionUnobservedBound: cell.connectionUnobservedBound
          })
    }))
  )
}

export function directorTopologyChange(currentValue, desiredValue, cellId) {
  const current = JSON.parse(directorCellsJson(currentValue, { allowMissingRegion: true }))
  const desired = JSON.parse(directorCellsJson(desiredValue))
  if (
    current.length !== desired.length ||
    desired.some(({ id }, index) => id !== current[index]?.id)
  ) {
    throw new Error('director topology changes the Relay cell set or order')
  }
  let changed = false
  for (let index = 0; index < desired.length; index += 1) {
    const before = structuredClone(current[index])
    const after = structuredClone(desired[index])
    if (after.id === cellId) {
      delete before.connectionHardCap
      delete before.connectionUnobservedBound
      delete after.connectionHardCap
      delete after.connectionUnobservedBound
      changed = !isDeepStrictEqual(current[index], desired[index])
    }
    if (!isDeepStrictEqual(before, after)) {
      throw new Error('director topology changes fields outside the reviewed capacity pair')
    }
  }
  if (!desired.some(({ id }) => id === cellId)) {
    throw new Error('director topology omits the reviewed capacity cell')
  }
  return { changed, value: JSON.stringify(desired) }
}

export function directorCellSetAddition(currentValue, desiredValue) {
  const current = JSON.parse(directorCellsJson(currentValue, { allowMissingRegion: true }))
  const desired = JSON.parse(directorCellsJson(desiredValue))
  if (desired.length < current.length) {
    throw new Error('director topology addition cannot remove cells')
  }
  const desiredById = new Map(desired.map((cell) => [cell.id, cell]))
  if (current.some((cell) => !isDeepStrictEqual(desiredById.get(cell.id), cell))) {
    throw new Error('director topology addition changes an existing cell')
  }
  const currentIds = new Set(current.map((cell) => cell.id))
  const additions = desired.filter((cell) => !currentIds.has(cell.id))
  if (additions.some((cell) => cell.initiallyEnabled !== false)) {
    throw new Error('director topology additions must start disabled')
  }
  return { changed: additions.length > 0, value: JSON.stringify(desired) }
}

export function directorDeploymentEnvironment(config) {
  const imageDigest = config.image?.match(/@(sha256:[a-f0-9]{64})$/)?.[1]
  if (config.image !== undefined && imageDigest === undefined) {
    throw new Error('--image must use an immutable digest for director deployments')
  }
  const environment = {
    ...DIRECTOR_ADMISSION_ENVIRONMENT,
    ORCA_RELAY_ADMISSION_SELECTOR_VERSION: SELECTOR_REVISION_MARKER,
    ...(imageDigest === undefined ? {} : { ORCA_RELAY_IMAGE_DIGEST: imageDigest })
  }
  const serviceAccount = projectServiceAccount(config, 'capacity-service-account')
  const asiaProofServiceAccount = projectServiceAccount(config, 'asia-proof-service-account')
  const rehomeDirectorServiceAccount = projectServiceAccount(
    config,
    'rehome-director-service-account'
  )
  const cellsJson = directorCellsJson(config['director-cells-json'])
  if (serviceAccount !== undefined) {
    environment.ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT = serviceAccount
  }
  if (asiaProofServiceAccount !== undefined) {
    environment.ORCA_RELAY_ASIA_PROOF_SERVICE_ACCOUNT = asiaProofServiceAccount
  }
  if (rehomeDirectorServiceAccount !== undefined) {
    environment[DIRECTOR_REHOME_IDENTITY_ENV] = rehomeDirectorServiceAccount
    environment[DIRECTOR_REHOME_AUDIENCE_ENV] = config['rehome-audience']
  }
  if (cellsJson !== undefined) environment.ORCA_RELAY_CELLS_JSON = cellsJson
  return environment
}

export function environmentUpdateValue(environment) {
  const entries = Object.entries(environment)
  if (entries.every(([key, value]) => !key.includes(',') && !value.includes(','))) {
    return entries.map(([key, value]) => `${key}=${value}`).join(',')
  }
  const delimiter = ['~', '|', '@', '%', ';'].find((candidate) =>
    entries.every(([key, value]) => !key.includes(candidate) && !value.includes(candidate))
  )
  if (!delimiter) throw new Error('candidate environment has no safe gcloud delimiter')
  return `^${delimiter}^${entries.map(([key, value]) => `${key}=${value}`).join(delimiter)}`
}

export function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument ${key ?? ''}`)
    values[key.slice(2)] = value
  }
  const required = ['project', 'region', 'service', 'image', 'role', 'release-id']
  for (const key of required) if (!values[key]) throw new Error(`missing --${key}`)
  if (!['director', 'cell'].includes(values.role)) throw new Error('--role must be director or cell')
  if (values['min-instances'] !== undefined && !/^(0|[1-9][0-9]*)$/.test(values['min-instances'])) {
    throw new Error('--min-instances must be a nonnegative integer')
  }
  if (values['max-instances'] !== undefined && !/^[1-9][0-9]*$/.test(values['max-instances'])) {
    throw new Error('--max-instances must be a positive integer')
  }
  if (values.role === 'cell') {
    for (const key of ['director-origin', 'admin-audience']) {
      if (!values[key]) throw new Error(`missing --${key}`)
    }
    if (!['enabled', 'disabled'].includes(values['final-admission'] ?? 'enabled')) {
      throw new Error('--final-admission must be enabled or disabled')
    }
    if (
      values['capacity-service-account'] !== undefined ||
      values['director-cells-json'] !== undefined ||
      values['runtime-service-account'] !== undefined ||
      values['rehome-director-service-account'] !== undefined ||
      values['rehome-audience'] !== undefined ||
      values['expected-rehome-generation'] !== undefined ||
      values['rehome-control-origin'] !== undefined
    ) {
      throw new Error('director configuration arguments require --role director')
    }
  }
  if (
    values.role === 'director' &&
    values['capacity-cell-id'] !== undefined &&
    values['director-cells-json'] === undefined
  ) {
    throw new Error('--capacity-cell-id requires --director-cells-json')
  }
  if (values['regional-placement-enabled'] !== undefined) {
    throw new Error('regional placement changes use the audited runtime-setting step')
  }
  if (
    values['regional-placement-secret-version'] !== undefined &&
    !/^[1-9][0-9]*$/.test(values['regional-placement-secret-version'])
  ) {
    throw new Error('--regional-placement-secret-version must be a positive integer')
  }
  if (!['true', 'false'].includes(values['prune-revisions'] ?? 'false')) {
    throw new Error('--prune-revisions must be true or false')
  }
  if (!['true', 'false'].includes(values['bootstrap-runtime-identity'] ?? 'false')) {
    throw new Error('--bootstrap-runtime-identity must be true or false')
  }
  if (values.role === 'director') {
    directorDeploymentEnvironment(values)
    projectServiceAccount(values, 'runtime-service-account')
    projectServiceAccount(values, 'predecessor-runtime-service-account')
    if (
      values['bootstrap-runtime-identity'] === 'true' &&
      (!values['runtime-service-account'] ||
        !values['predecessor-runtime-service-account'] ||
        !values['predecessor-image-digest'])
    ) {
      throw new Error('runtime identity bootstrap requires exact predecessor digest and identities')
    }
    if (
      values['predecessor-image-digest'] !== undefined &&
      !/^sha256:[a-f0-9]{64}$/.test(values['predecessor-image-digest'])
    ) {
      throw new Error('--predecessor-image-digest must be an immutable digest')
    }
    const rehomePair = [
      'rehome-director-service-account',
      'rehome-audience'
    ].map((key) => values[key] !== undefined)
    if (rehomePair[0] !== rehomePair[1]) {
      throw new Error('rehome identity and audience must be configured together')
    }
    if (values['rehome-audience'] !== undefined) {
      const audience = new URL(values['rehome-audience'])
      if (
        audience.protocol !== 'https:' ||
        audience.pathname !== '/v1/admin/host-drain' ||
        audience.search ||
        audience.hash
      ) {
        throw new Error('--rehome-audience must be an exact host-drain HTTPS URL')
      }
    }
    const controlArguments = [
      'expected-rehome-generation',
      'rehome-control-origin',
      'admin-audience'
    ].map((key) => values[key] !== undefined)
    if (controlArguments.some(Boolean) && !controlArguments.every(Boolean)) {
      throw new Error('durable rehome verification arguments must be configured together')
    }
    if (
      values['expected-rehome-generation'] !== undefined &&
      !/^(0|[1-9][0-9]*)$/.test(values['expected-rehome-generation'])
    ) {
      throw new Error('--expected-rehome-generation must be a nonnegative integer')
    }
    if (values['rehome-control-origin'] !== undefined) {
      const origin = new URL(values['rehome-control-origin'])
      if (origin.protocol !== 'https:' || origin.origin !== values['rehome-control-origin']) {
        throw new Error('--rehome-control-origin must be an HTTPS origin')
      }
    }
  }
  return values
}

function commandJson(args) {
  const result = spawnSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    throw new Error(`gcloud ${args.slice(0, 4).join(' ')} failed: ${result.stderr.trim()}`)
  }
  return JSON.parse(result.stdout)
}

function commandText(args, { sensitive = false } = {}) {
  const result = spawnSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) {
    const detail = sensitive ? 'credential command failed' : result.stderr.trim()
    throw new Error(`gcloud ${args.slice(0, 4).join(' ')} failed: ${detail}`)
  }
  return result.stdout.trim()
}

export function suppliedAdminIdentityToken(environment = process.env) {
  const token = environment.ORCA_RELAY_ADMIN_ID_TOKEN
  if (token === undefined) return null
  // The workflow supplies a masked Google ID token because external-account gcloud cannot mint one directly.
  if (token.length > 8_192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('invalid supplied admin identity token')
  }
  return token
}

function adminIdentityToken(config) {
  return (
    suppliedAdminIdentityToken() ??
    commandText(['auth', 'print-identity-token', `--audiences=${config['admin-audience']}`], {
      sensitive: true
    })
  )
}

function serviceArguments(config) {
  return ['--project', config.project, '--region', config.region]
}

export function directorStartupProbeArguments(role) {
  return role === 'director' ? ['--startup-probe', DIRECTOR_STARTUP_PROBE] : []
}

function describeService(config) {
  return commandJson([
    'run',
    'services',
    'describe',
    config.service,
    ...serviceArguments(config),
    '--format=json'
  ])
}

function describeRevision(config, revision) {
  return commandJson([
    'run',
    'revisions',
    'describe',
    revision,
    ...serviceArguments(config),
    '--format=json'
  ])
}

function listRevisions(config) {
  return commandJson([
    'run',
    'revisions',
    'list',
    '--service',
    config.service,
    ...serviceArguments(config),
    '--format=json'
  ])
}

function deleteRevision(config, revision) {
  commandText([
    'run',
    'revisions',
    'delete',
    revision,
    ...serviceArguments(config),
    '--quiet'
  ])
}

function updateTraffic(config, args) {
  commandText([
    'run',
    'services',
    'update-traffic',
    config.service,
    ...serviceArguments(config),
    ...args,
    '--quiet'
  ])
}

function removeDirectorTrafficTags(config, operations, retained = new Set()) {
  const tags = trafficTags(operations.describeService(config)).filter(
    (tag) => !retained.has(tag)
  )
  if (tags.length === 0) return
  try {
    operations.updateTraffic(config, [`--remove-tags=${tags.join(',')}`])
  } catch (error) {
    const remaining = new Set(trafficTags(operations.describeService(config)))
    if (tags.some((tag) => remaining.has(tag))) throw error
  }
}

function pruneDirectorRevisions(config, operations) {
  const service = operations.describeService(config)
  const retained = new Set([
    activeRevision(service),
    taggedTraffic(service, SELECTOR_ROLLBACK_TAG).revision
  ])
  for (const revision of operations.listRevisions(config)) {
    const name = revision.metadata?.name
    if (!name) throw new Error('director revision list contains an unnamed revision')
    if (!retained.has(name)) operations.deleteRevision(config, name)
  }
  const remaining = operations
    .listRevisions(config)
    .map((revision) => revision.metadata?.name)
  if (
    remaining.length !== retained.size ||
    remaining.some((name) => !name || !retained.has(name))
  ) {
    throw new Error('old director revisions remain after deployment')
  }
}

function deployCandidate(
  config,
  tag,
  env = {},
  image = config.image,
  minInstances = config['min-instances'],
  maxInstances,
  regionalPlacementVersion
) {
  const args = [
    'run',
    'services',
    'update',
    config.service,
    ...serviceArguments(config),
    '--image',
    image,
    '--tag',
    tag,
    '--no-traffic'
  ]
  if (maxInstances !== undefined) args.push('--max', String(maxInstances))
  if (config.role === 'director') {
    args.push(
      '--update-secrets',
      `${DIRECTOR_REGIONAL_PLACEMENT_ENV}=${DIRECTOR_REGIONAL_PLACEMENT_SECRET}:${regionalPlacementVersion}`
    )
    if (config['runtime-service-account'] !== undefined) {
      args.push('--service-account', config['runtime-service-account'])
    }
  }
  args.push(...directorStartupProbeArguments(config.role))
  if (minInstances !== undefined) {
    args.push('--min-instances', String(minInstances))
  }
  const entries = Object.entries(env)
  if (entries.length > 0) {
    args.push('--update-env-vars', environmentUpdateValue(env))
  }
  args.push('--quiet')
  commandText(args)
}

function revisionShape(revision, mutableEnvironment, allowServiceAccountChange = false) {
  const spec = structuredClone(revision.spec ?? {})
  if (allowServiceAccountChange) delete spec.serviceAccountName
  for (const container of spec.containers ?? []) {
    delete container.image
    delete container.startupProbe
    container.env = (container.env ?? []).filter(
      ({ name }) => !(name in mutableEnvironment)
    )
  }
  const ignoredAnnotations = new Set([
    'autoscaling.knative.dev/minScale',
    'run.googleapis.com/client-name',
    'run.googleapis.com/client-version',
    'run.googleapis.com/operation-id',
    'serving.knative.dev/creator'
  ])
  const annotations = Object.fromEntries(
    Object.entries(revision.metadata?.annotations ?? {}).filter(
      ([name]) => !ignoredAnnotations.has(name)
    )
  )
  return { spec, annotations }
}

function assertPreservedRevisionShape(
  serving,
  candidate,
  mutableEnvironment,
  allowServiceAccountChange = false
) {
  if (!isDeepStrictEqual(
    revisionShape(serving, mutableEnvironment, allowServiceAccountChange),
    revisionShape(candidate, mutableEnvironment, allowServiceAccountChange)
  )) {
    throw new Error('director candidate changed unrelated revision shape')
  }
}

function releaseLabel(releaseId) {
  const normalized = releaseId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  if (!normalized) throw new Error('release id has no usable characters')
  return normalized.slice(0, 32).replace(/-$/g, '')
}

export function cloudRunTrafficTag(service, prefix, releaseId) {
  if (!/^[a-z][a-z0-9-]*$/.test(service)) throw new Error('invalid Cloud Run service name')
  if (!/^[a-z][a-z0-9-]*$/.test(prefix)) throw new Error('invalid Cloud Run tag prefix')
  const digest = createHash('sha256').update(releaseLabel(releaseId)).digest('hex').slice(0, 9)
  const tag = `${prefix}-${digest}`
  // Cloud Run imposes this combined bound in addition to the standalone tag bound.
  if (service.length + tag.length > 46) throw new Error('Cloud Run service leaves no safe tag space')
  return tag
}

function cellIdentifier(sourceCellId, releaseId) {
  const suffix = releaseLabel(releaseId)
  const available = 128 - suffix.length - 2
  return `${sourceCellId.slice(0, available)}--${suffix}`
}

async function waitForHealth(origin, connectionCapacityProtocol) {
  const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(15_000) })
  const body = await response.json()
  if (
    !response.ok ||
    body.ok !== true ||
    (connectionCapacityProtocol !== undefined &&
      body.connectionCapacityProtocol !== connectionCapacityProtocol)
  ) {
    throw new Error(`candidate health failed at ${origin}`)
  }
}

export async function waitForEvacuationCapacity(
  adminPost,
  sourceCellId,
  targetCellId,
  { pollIntervalMs = POLL_INTERVAL_MS, timeoutMs = MIGRATION_TIMEOUT_MS } = {}
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await adminPost('/v1/admin/evacuation-capacity', {
        v: 1,
        sourceCellId,
        targetCellId
      })
    } catch (error) {
      if (!(error instanceof Error) || !error.message.endsWith(': target_cell_unavailable')) throw error
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }
  }
  throw new Error('timed out waiting for candidate cell readiness')
}

async function adminClient(config) {
  const token = adminIdentityToken(config)
  return async (path, body) => {
    const response = await fetch(`${config['director-origin']}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000)
    })
    const result = await response.json().catch(() => ({ error: `http_${response.status}` }))
    if (!response.ok) throw new Error(`${path} failed: ${result.error ?? response.status}`)
    return result
  }
}

export async function assertRegionalRehomeDisabled(
  config,
  origin,
  fetchImpl = fetch
) {
  const response = await fetchImpl(`${origin}/v1/admin/regional-rehome-control`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminIdentityToken(config)}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, action: 'inspect' }),
    signal: AbortSignal.timeout(30_000)
  })
  const result = await response.json().catch(() => ({ error: `http_${response.status}` }))
  if (!response.ok) {
    throw new Error(`regional rehome inspection failed: ${result.error ?? response.status}`)
  }
  const generation = Number(config['expected-rehome-generation'])
  if (
    result.v !== 1 ||
    result.control?.enabled !== false ||
    result.control?.generation !== generation
  ) {
    throw new Error('regional rehome control is not durably disabled at the expected generation')
  }
  return result.control
}

function assertDirectorRevisionIdentity(revision, config) {
  const expectedRuntimeServiceAccount = config['runtime-service-account']
  if (
    expectedRuntimeServiceAccount !== undefined &&
    revision.spec?.serviceAccountName !== expectedRuntimeServiceAccount
  ) {
    throw new Error('director revision uses an unexpected runtime service account')
  }
}

export async function deployDirector(config, tag, overrides = {}) {
  const operations = {
    deployCandidate,
    describeService,
    describeRevision,
    listRevisions,
    deleteRevision,
    updateTraffic,
    waitForHealth,
    assertRegionalRehomeDisabled,
    ...overrides
  }
  // Why: gcloud does not carry minScale onto a new revision, and the candidate below takes
  // 100% of traffic. Inheriting the serving floor keeps one owner for the number instead of
  // restating it here; public admission is per-instance, so losing it shrinks fleet capacity.
  const initialService = operations.describeService(config)
  const servingRevision = operations.describeRevision(config, activeRevision(initialService))
  const bootstrapRuntimeIdentity = config['bootstrap-runtime-identity'] === 'true'
  if (bootstrapRuntimeIdentity) {
    if (
      servingRevision.spec?.serviceAccountName !==
      config['predecessor-runtime-service-account']
    ) {
      throw new Error('director predecessor runtime service account does not match')
    }
    if (
      config['predecessor-runtime-service-account'] === config['runtime-service-account']
    ) {
      throw new Error('director runtime identity bootstrap has already completed')
    }
    const predecessorDigest = servingRevision.spec?.containers?.[0]?.image?.split('@').at(-1)
    if (predecessorDigest !== config['predecessor-image-digest']) {
      throw new Error('director predecessor image digest does not match')
    }
  } else {
    assertDirectorRevisionIdentity(servingRevision, config)
  }
  const servingMinimumInstances = revisionMinimumInstances(servingRevision)
  const servingMaximumInstances = revisionMaximumInstances(servingRevision)
  const requiredMaximumInstances = config['max-instances'] === undefined
    ? servingMaximumInstances
    : Number(config['max-instances'])
  if (servingMaximumInstances !== requiredMaximumInstances) {
    throw new Error(
      `serving revision holds ${servingMaximumInstances} maximum instances, expected ${requiredMaximumInstances}`
    )
  }
  const servingSecrets = revisionSecretEnvironment(servingRevision)
  const servingRegionalPlacementVersion =
    servingSecrets[DIRECTOR_REGIONAL_PLACEMENT_ENV]?.version
  const targetRegionalPlacementVersion =
    config['regional-placement-secret-version'] ?? servingRegionalPlacementVersion
  if (!/^[1-9][0-9]*$/.test(targetRegionalPlacementVersion ?? '')) {
    throw new Error('director deployment requires an exact regional placement secret version')
  }
  const rollbackRegionalPlacementVersion =
    /^[1-9][0-9]*$/.test(servingRegionalPlacementVersion ?? '')
      ? servingRegionalPlacementVersion
      : targetRegionalPlacementVersion
  const requiredMinimumInstances =
    config['min-instances'] === undefined
      ? servingMinimumInstances
      : Number(config['min-instances'])
  const requiredCapacityProtocol =
    config['prune-revisions'] === 'true' ? CONNECTION_CAPACITY_PROTOCOL : undefined
  const currentEnvironment = revisionEnvironment(servingRevision)
  const deploymentEnvironment = directorDeploymentEnvironment(config)
  const mutableEnvironment = {
    ...deploymentEnvironment,
    [DIRECTOR_REGIONAL_PLACEMENT_ENV]: ''
  }
  const topology = config['director-cells-json'] === undefined
    ? { changed: false }
    : config['capacity-cell-id'] === undefined
      ? directorCellSetAddition(
          currentEnvironment.ORCA_RELAY_CELLS_JSON,
          deploymentEnvironment.ORCA_RELAY_CELLS_JSON
        )
      : directorTopologyChange(
          currentEnvironment.ORCA_RELAY_CELLS_JSON,
          deploymentEnvironment.ORCA_RELAY_CELLS_JSON,
          config['capacity-cell-id']
        )
  const verifyRehomeDisabled = async (origin) => {
    if (config['expected-rehome-generation'] === undefined) return
    await operations.assertRegionalRehomeDisabled(config, origin)
  }
  if (!bootstrapRuntimeIdentity) {
    await verifyRehomeDisabled(config['rehome-control-origin'])
  }
  removeDirectorTrafficTags(config, operations)
  let deployed
  let promoted = false
  try {
    operations.deployCandidate(
      config,
      SELECTOR_ROLLBACK_TAG,
      deploymentEnvironment,
      config.image,
      0,
      requiredMaximumInstances,
      rollbackRegionalPlacementVersion
    )
    const rollback = taggedTraffic(
      operations.describeService(config),
      SELECTOR_ROLLBACK_TAG
    )
    const rollbackRevision = operations.describeRevision(config, rollback.revision)
    assertDirectorRevisionIdentity(rollbackRevision, config)
    assertPreservedRevisionShape(
      servingRevision,
      rollbackRevision,
      mutableEnvironment,
      bootstrapRuntimeIdentity
    )
    const rollbackEnvironment = revisionEnvironment(rollbackRevision)
    const rollbackSecrets = revisionSecretEnvironment(rollbackRevision)
    if (
      rollbackEnvironment.ORCA_RELAY_ROLE !== 'director' ||
      rollbackEnvironment.ORCA_RELAY_ADMISSION_SELECTOR_VERSION !==
        SELECTOR_REVISION_MARKER ||
      !hasExpectedEnvironment(rollbackEnvironment, deploymentEnvironment) ||
      rollbackSecrets[DIRECTOR_REGIONAL_PLACEMENT_ENV]?.secret !==
        DIRECTOR_REGIONAL_PLACEMENT_SECRET ||
      rollbackSecrets[DIRECTOR_REGIONAL_PLACEMENT_ENV]?.version !==
        rollbackRegionalPlacementVersion ||
      revisionMinimumInstances(rollbackRevision) !== 0
    ) {
      throw new Error('rollback revision is not selector-compatible')
    }
    await operations.waitForHealth(rollback.origin, requiredCapacityProtocol)
    await verifyRehomeDisabled(rollback.origin)
    operations.deployCandidate(
      config,
      tag,
      deploymentEnvironment,
      config.image,
      requiredMinimumInstances,
      requiredMaximumInstances,
      targetRegionalPlacementVersion
    )
    const candidate = taggedTraffic(operations.describeService(config), tag)
    const candidateRevision = operations.describeRevision(config, candidate.revision)
    assertDirectorRevisionIdentity(candidateRevision, config)
    assertPreservedRevisionShape(
      servingRevision,
      candidateRevision,
      mutableEnvironment,
      bootstrapRuntimeIdentity
    )
    const environment = revisionEnvironment(candidateRevision)
    const secrets = revisionSecretEnvironment(candidateRevision)
    if (
      environment.ORCA_RELAY_ROLE !== 'director' ||
      environment.ORCA_RELAY_ADMISSION_SELECTOR_VERSION !== SELECTOR_REVISION_MARKER ||
      !hasExpectedEnvironment(environment, deploymentEnvironment) ||
      secrets[DIRECTOR_REGIONAL_PLACEMENT_ENV]?.secret !==
        DIRECTOR_REGIONAL_PLACEMENT_SECRET ||
      secrets[DIRECTOR_REGIONAL_PLACEMENT_ENV]?.version !==
        targetRegionalPlacementVersion
    ) {
      throw new Error('stable relay service is not selector-compatible')
    }
    // Fail before the traffic move, so a candidate that lost the floor never serves.
    const candidateMinimumInstances = revisionMinimumInstances(candidateRevision)
    if (candidateMinimumInstances !== requiredMinimumInstances) {
      throw new Error(
        `candidate holds ${candidateMinimumInstances} minimum instances, expected ${requiredMinimumInstances}`
      )
    }
    await operations.waitForHealth(candidate.origin, requiredCapacityProtocol)
    await verifyRehomeDisabled(candidate.origin)
    operations.updateTraffic(config, [`--to-tags=${tag}=100`])
    promoted = true
    removeDirectorTrafficTags(config, operations, new Set([SELECTOR_ROLLBACK_TAG]))
    deployed = {
      event: 'director_deployed',
      revision: candidate.revision,
      rollbackRevision: rollback.revision,
      topologyChanged: topology.changed
    }
  } catch (error) {
    const recoveryErrors = [error]
    if (promoted) {
      try {
        operations.updateTraffic(config, [`--to-tags=${SELECTOR_ROLLBACK_TAG}=100`])
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError)
      }
    }
    try {
      removeDirectorTrafficTags(
        config,
        operations,
        promoted ? new Set([SELECTOR_ROLLBACK_TAG]) : new Set()
      )
    } catch (cleanupError) {
      recoveryErrors.push(cleanupError)
    }
    if (recoveryErrors.length > 1) {
      const details = recoveryErrors
        .map((failure) => failure instanceof Error ? failure.message : String(failure))
        .join('; ')
      throw new AggregateError(recoveryErrors, `director deploy recovery failed: ${details}`)
    }
    throw error
  }
  if (config['prune-revisions'] === 'true') pruneDirectorRevisions(config, operations)
  process.stdout.write(`${JSON.stringify(deployed)}\n`)
}

async function waitForTargetRegistration(adminPost, sourceCellId, targetCellId) {
  const deadline = Date.now() + MIGRATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await adminPost('/v1/admin/evacuation-status', {
      v: 1,
      sourceCellId,
      targetCellId,
      completeReady: false
    })
    process.stdout.write(
      `${JSON.stringify({ event: 'migration_registration', ...status })}\n`
    )
    if (status.inProgress === status.targetRegistered) return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error('timed out waiting for target control registrations')
}

async function waitForCompletion(adminPost, sourceCellId, targetCellId) {
  const deadline = Date.now() + MIGRATION_TIMEOUT_MS
  while (Date.now() < deadline) {
    const status = await adminPost('/v1/admin/evacuation-status', {
      v: 1,
      sourceCellId,
      targetCellId,
      completeReady: true
    })
    process.stdout.write(`${JSON.stringify({ event: 'migration_completion', ...status })}\n`)
    if (status.inProgress === 0) return
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error('timed out waiting for source activity to drain')
}

async function startAllEvacuations(adminPost, sourceCellId, targetCellId) {
  for (;;) {
    const result = await adminPost('/v1/admin/evacuate-cell', {
      v: 1,
      sourceCellId,
      targetCellId,
      limit: 100
    })
    process.stdout.write(`${JSON.stringify({ event: 'migration_batch', started: result.started })}\n`)
    if (result.started === 0) return
  }
}

async function deployCell(config, tag, oldTag, drainTag) {
  const initialService = describeService(config)
  const currentRevision = activeRevision(initialService)
  const currentRevisionState = describeRevision(config, currentRevision)
  const currentEnv = revisionEnvironment(currentRevisionState)
  const currentImage = currentRevisionState.spec?.containers?.[0]?.image
  const sourceCellId = currentEnv.ORCA_RELAY_CELL_ID
  const sourceOrigin = currentEnv.ORCA_RELAY_CELL_URL
  const capacityRequests = Number(currentEnv.ORCA_RELAY_CELL_CAPACITY)
  if (
    currentEnv.ORCA_RELAY_ROLE !== 'cell' ||
    !sourceCellId ||
    !sourceOrigin ||
    !currentImage ||
    !Number.isInteger(capacityRequests) ||
    capacityRequests <= 0
  ) {
    throw new Error('active cell revision has invalid role, identity, image, or capacity')
  }
  updateTraffic(config, [`--update-tags=${drainTag}=${currentRevision}`])
  const drainRevision = taggedTraffic(describeService(config), drainTag)
  const previousOrigin = taggedRevisionOrigin(initialService.status.url, oldTag)
  const candidateOrigin = taggedRevisionOrigin(initialService.status.url, tag)
  const targetCellId = cellIdentifier(sourceCellId, config['release-id'])
  const adminPost = await adminClient(config)

  await adminPost('/v1/admin/cell-config', {
    v: 1,
    cellId: targetCellId,
    cellUrl: candidateOrigin,
    capacityRequests,
    enabled: false
  })
  deployCandidate(config, tag, {
    ORCA_RELAY_CELL_ID: targetCellId,
    ORCA_RELAY_CELL_URL: candidateOrigin,
    ORCA_RELAY_PUBLIC_URL: candidateOrigin
  })
  const candidate = taggedTraffic(describeService(config), tag)
  if (candidate.origin !== candidateOrigin) {
    throw new Error('queried candidate tag URL mismatches its configured origin')
  }
  await waitForHealth(candidate.origin)
  deployCandidate(
    config,
    oldTag,
    {
      ORCA_RELAY_CELL_ID: sourceCellId,
      ORCA_RELAY_CELL_URL: previousOrigin,
      ORCA_RELAY_PUBLIC_URL: previousOrigin
    },
    currentImage
  )
  const previous = taggedTraffic(describeService(config), oldTag)
  if (previous.origin !== previousOrigin) {
    throw new Error('queried previous tag URL mismatches its configured origin')
  }
  await waitForHealth(previous.origin)

  // HTTP health precedes the authenticated heartbeat that makes a migration target eligible.
  await waitForEvacuationCapacity(adminPost, sourceCellId, targetCellId)
  await adminPost('/v1/admin/cell-state', { v: 1, cellId: sourceCellId, enabled: false })
  let sourceReconfigured = false
  try {
    const capacity = await adminPost('/v1/admin/evacuation-capacity', {
      v: 1,
      sourceCellId,
      targetCellId
    })
    process.stdout.write(`${JSON.stringify({ event: 'migration_capacity', ...capacity })}\n`)
    if (capacity.requiredTargetUnits > capacity.availableTargetUnits) {
      throw new Error('candidate lacks durable reservation headroom for target-first migration')
    }
    // The keeper uses the old image and cell identity without competing with live controls.
    await adminPost('/v1/admin/cell-config', {
      v: 1,
      cellId: sourceCellId,
      cellUrl: previous.origin,
      capacityRequests,
      enabled: false
    })
    sourceReconfigured = true
    await adminPost('/v1/admin/cell-config', {
      v: 1,
      cellId: targetCellId,
      cellUrl: candidate.origin,
      capacityRequests,
      enabled: true
    })
  } catch (error) {
    if (sourceReconfigured) {
      await adminPost('/v1/admin/cell-config', {
        v: 1,
        cellId: sourceCellId,
        cellUrl: sourceOrigin,
        capacityRequests,
        enabled: true
      })
    } else {
      await adminPost('/v1/admin/cell-state', { v: 1, cellId: sourceCellId, enabled: true })
    }
    throw error
  }
  await startAllEvacuations(adminPost, sourceCellId, targetCellId)

  await fetch(`${drainRevision.origin}/v1/admin/drain`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${adminIdentityToken(config)}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, graceMs: 120_000 }),
    signal: AbortSignal.timeout(30_000)
  }).then(async (response) => {
    if (!response.ok) throw new Error(`old revision drain failed: ${response.status}`)
  })

  await waitForTargetRegistration(adminPost, sourceCellId, targetCellId)
  updateTraffic(config, [`--to-tags=${tag}=100`])
  await waitForCompletion(adminPost, sourceCellId, targetCellId)
  const finalEnabled = (config['final-admission'] ?? 'enabled') === 'enabled'
  if (!finalEnabled) {
    // GCE-backed staging keeps stamped cells runnable for regression without assigning normal traffic.
    await adminPost('/v1/admin/cell-state', { v: 1, cellId: targetCellId, enabled: false })
  }
  process.stdout.write(
    `${JSON.stringify({
      event: 'cell_deployed',
      service: config.service,
      sourceCellId,
      targetCellId,
      enabled: finalEnabled,
      drainRevision: drainRevision.revision,
      previousRevision: previous.revision,
      candidateRevision: candidate.revision
    })}\n`
  )
}

export async function main(argv = process.argv.slice(2)) {
  const config = parseArguments(argv)
  const tag = cloudRunTrafficTag(config.service, 'candidate', config['release-id'])
  const oldTag = cloudRunTrafficTag(config.service, 'previous', config['release-id'])
  const drainTag = cloudRunTrafficTag(config.service, 'drain', config['release-id'])
  if (config.role === 'director') await deployDirector(config, tag)
  else await deployCell(config, tag, oldTag, drainTag)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
