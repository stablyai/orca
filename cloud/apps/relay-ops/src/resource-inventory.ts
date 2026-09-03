import { z } from 'zod'
import type { RelayOpsEnvironment, RelayOpsCellConfig } from './environment-config.js'
import type { GcloudClient } from './gcloud-client.js'
import { INCIDENT_MONITOR_THRESHOLDS } from './incident-monitor.js'

const RunServiceSchema = z.object({
  template: z.object({
    scaling: z.object({
      minInstanceCount: z.number().optional(),
      maxInstanceCount: z.number().optional()
    }).optional(),
    containers: z.array(z.object({ image: z.string() })).min(1)
  }),
  conditions: z.array(z.object({ state: z.string() })).default([]),
  latestReadyRevision: z.string().optional()
})

const SqlInstanceSchema = z.object({
  state: z.string(),
  databaseVersion: z.string(),
  settings: z.object({
    activationPolicy: z.string(),
    availabilityType: z.string().optional(),
    tier: z.string()
  })
})

const MigSchema = z.object({
  name: z.string(),
  targetSize: z.number(),
  size: z.union([z.string(), z.number()]).transform(Number).optional(),
  instanceGroup: z.string(),
  instanceTemplate: z.string(),
  status: z.object({ isStable: z.boolean().default(false) }).default({ isStable: false })
})

const TemplateSchema = z.object({
  properties: z.object({
    metadata: z.object({
      items: z.array(z.object({ key: z.string(), value: z.string().optional() })).default([])
    }).optional()
  })
})

const BackendHealthGroupSchema = z.object({
  healthStatus: z.array(z.object({ healthState: z.string() })).default([])
})
const BackendHealthSchema = z.union([
  BackendHealthGroupSchema,
  z.array(z.object({ status: BackendHealthGroupSchema }))
])

const CertificateSchema = z.object({
  expireTime: z.string().optional(),
  managed: z.object({
    domains: z.array(z.string()).default([]),
    state: z.string()
  })
})

export type EndpointHealth = {
  health: boolean | null
  ready: boolean | null
  latencyMs: number | null
}

export type ServiceInventory = {
  ready: boolean
  revision: string | null
  image: string
  minInstances: number
  maxInstances: number
}

export type CellInventory = RelayOpsCellConfig & {
  migName: string
  targetSize: number | null
  runningInstances: number | null
  stable: boolean | null
  template: string | null
  imageDigest: string | null
  backendHealth: 'healthy' | 'unhealthy' | 'empty' | 'unknown'
  endpoint: EndpointHealth
}

export type ResourceInventory = {
  director: ServiceInventory | null
  auth: ServiceInventory | null
  sql: {
    state: string
    activationPolicy: string
    tier: string
    availabilityType: string
    databaseVersion: string
  } | null
  certificate: { state: string; domains: string[]; expireTime: string | null } | null
  directorEndpoint: EndpointHealth
  authEndpoint: EndpointHealth
  cells: CellInventory[]
  warnings: string[]
}

const unavailableEndpoint = (): EndpointHealth => ({ health: null, ready: null, latencyMs: null })
const independentEndpointRetryDelayMs = 11_000

function finalSegment(value: string): string {
  return value.split('/').at(-1) ?? value
}

function parseService(value: unknown): ServiceInventory {
  const service = RunServiceSchema.parse(value)
  return {
    ready: service.conditions.length > 0 && service.conditions.every(
      (condition) => condition.state === 'CONDITION_SUCCEEDED'
    ),
    revision: service.latestReadyRevision ? finalSegment(service.latestReadyRevision) : null,
    image: service.template.containers[0]!.image,
    minInstances: service.template.scaling?.minInstanceCount ?? 0,
    maxInstances: service.template.scaling?.maxInstanceCount ?? 0
  }
}

async function googleRequest(
  fetchImpl: typeof fetch,
  token: string,
  url: string,
  init: RequestInit = {}
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {})
    },
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`Google API returned ${response.status}`)
  return await response.json()
}

async function endpointProbe(origin: string, fetchImpl: typeof fetch): Promise<EndpointHealth> {
  const startedAt = performance.now()
  const check = async (path: '/health' | '/ready'): Promise<boolean> => {
    try {
      const response = await fetchImpl(`${origin}${path}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(8_000)
      })
      return response.ok
    } catch {
      return false
    }
  }
  const [health, ready] = await Promise.all([check('/health'), check('/ready')])
  return { health, ready, latencyMs: Math.round(performance.now() - startedAt) }
}

export async function probeEndpointHealth(
  origin: string,
  fetchImpl: typeof fetch,
  wait: (ms: number) => Promise<void> = async (ms) =>
    await new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
): Promise<EndpointHealth> {
  const first = await endpointProbe(origin, fetchImpl)
  if (
    first.health &&
    first.ready &&
    first.latencyMs !== null &&
    first.latencyMs <= INCIDENT_MONITOR_THRESHOLDS.endpointLatencyMs
  ) {
    return first
  }
  // Outwait Relay's ten-second readiness cache before treating the retry as independent.
  await wait(independentEndpointRetryDelayMs)
  return await endpointProbe(origin, fetchImpl)
}

function imageDigest(template: z.infer<typeof TemplateSchema>): string | null {
  const startupScript = template.properties.metadata?.items.find(
    (item) => item.key === 'startup-script'
  )?.value
  // Return only the immutable digest; startup metadata contains secret names and operational detail.
  return startupScript?.match(/ORCA_RELAY_IMAGE_DIGEST=%s\\n' '(sha256:[a-f0-9]{64})'/)?.[1] ?? null
}

function backendState(value: unknown): CellInventory['backendHealth'] {
  const parsedHealth = BackendHealthSchema.parse(value)
  const groups = Array.isArray(parsedHealth)
    ? parsedHealth.map((group) => group.status)
    : [parsedHealth]
  const states = groups.flatMap((group) => group.healthStatus.map((status) => status.healthState))
  if (states.length === 0) return 'empty'
  if (states.every((state) => state === 'HEALTHY')) return 'healthy'
  return 'unhealthy'
}

function unavailableCell(cell: RelayOpsCellConfig, migName: string): CellInventory {
  return {
    ...cell,
    migName,
    targetSize: null,
    runningInstances: null,
    stable: null,
    template: null,
    imageDigest: null,
    backendHealth: 'unknown',
    endpoint: unavailableEndpoint()
  }
}

async function readCell(
  environment: RelayOpsEnvironment,
  cell: RelayOpsCellConfig,
  mig: z.infer<typeof MigSchema> | null,
  token: string,
  fetchImpl: typeof fetch
): Promise<CellInventory> {
  const migName = `${environment.migPrefix}${cell.hostname}`
  if (!mig) return unavailableCell(cell, migName)
  // An empty fixed-one MIG cannot serve and must never be woken by observation.
  const endpoint = mig.targetSize > 0
    ? await probeEndpointHealth(cell.origin, fetchImpl)
    : unavailableEndpoint()
  const templateName = finalSegment(mig.instanceTemplate)
  const [templateResult, healthResult] = await Promise.allSettled([
    googleRequest(
      fetchImpl,
      token,
      `https://compute.googleapis.com/compute/v1/projects/${environment.project}/global/instanceTemplates/${templateName}`
    ),
    googleRequest(
      fetchImpl,
      token,
      `https://compute.googleapis.com/compute/v1/projects/${environment.project}/global/backendServices/${migName}/getHealth`,
      { method: 'POST', body: JSON.stringify({ group: mig.instanceGroup }) }
    )
  ])
  return {
    ...cell,
    migName,
    targetSize: mig.targetSize,
    runningInstances: mig.size ?? (mig.status.isStable ? mig.targetSize : null),
    stable: mig.status.isStable,
    template: templateName,
    imageDigest: templateResult.status === 'fulfilled'
      ? imageDigest(TemplateSchema.parse(templateResult.value))
      : null,
    backendHealth: healthResult.status === 'fulfilled'
      ? backendState(healthResult.value)
      : 'unknown',
    endpoint
  }
}

function parsed<S extends z.ZodTypeAny>(
  result: PromiseSettledResult<unknown>,
  schema: S,
  warning: string,
  warnings: string[]
): z.infer<S> | null {
  if (result.status === 'rejected') {
    warnings.push(warning)
    return null
  }
  const parsedValue = schema.safeParse(result.value)
  if (!parsedValue.success) {
    warnings.push(warning)
    return null
  }
  return parsedValue.data
}

function unavailableInventory(environment: RelayOpsEnvironment, warning: string): ResourceInventory {
  return {
    director: null,
    auth: null,
    sql: null,
    certificate: null,
    directorEndpoint: unavailableEndpoint(),
    authEndpoint: unavailableEndpoint(),
    cells: environment.cells.map((cell) =>
      unavailableCell(cell, `${environment.migPrefix}${cell.hostname}`)
    ),
    warnings: [warning]
  }
}

export async function readResourceInventory(
  environment: RelayOpsEnvironment,
  gcloud: GcloudClient,
  fetchImpl: typeof fetch = fetch
): Promise<ResourceInventory> {
  let token: string
  try {
    token = await gcloud.accessToken()
  } catch {
    return unavailableInventory(
      environment,
      'Google Cloud credentials are unavailable. Run gcloud auth login.'
    )
  }
  const runUrl = (service: string) =>
    `https://run.googleapis.com/v2/projects/${environment.project}/locations/${environment.region}/services/${service}`
  const migUrl = (cell: RelayOpsCellConfig) =>
    `https://compute.googleapis.com/compute/v1/projects/${environment.project}/zones/${cell.zone}/instanceGroupManagers/${environment.migPrefix}${cell.hostname}`
  const settled = await Promise.allSettled([
    googleRequest(fetchImpl, token, runUrl(environment.directorService)),
    googleRequest(fetchImpl, token, runUrl(environment.authService)),
    googleRequest(
      fetchImpl,
      token,
      `https://sqladmin.googleapis.com/sql/v1beta4/projects/${environment.project}/instances/${environment.sqlInstance}`
    ),
    googleRequest(
      fetchImpl,
      token,
      `https://certificatemanager.googleapis.com/v1/projects/${environment.project}/locations/global/certificates/${environment.certificateName}`
    ),
    ...environment.cells.map((cell) => googleRequest(fetchImpl, token, migUrl(cell)))
  ])
  const warnings: string[] = []
  const directorValue = parsed(settled[0]!, RunServiceSchema, 'Director service inventory is unavailable.', warnings)
  const authValue = parsed(settled[1]!, RunServiceSchema, 'Auth service inventory is unavailable.', warnings)
  const sqlValue = parsed(settled[2]!, SqlInstanceSchema, 'Cloud SQL inventory is unavailable.', warnings)
  const certificateValue = parsed(
    settled[3]!, CertificateSchema, 'TLS certificate inventory is unavailable.', warnings
  )
  const migValues = environment.cells.map((cell, index) => parsed(
    settled[index + 4]!,
    MigSchema,
    `${cell.hostname.toUpperCase()} MIG inventory is unavailable.`,
    warnings
  ))
  const controlPlaneSleeping =
    environment.id === 'staging' && sqlValue?.settings.activationPolicy === 'NEVER'
  // Health probes would cold-start scale-to-zero Cloud Run services, so sleeping staging is inventory-only.
  const [directorEndpoint, authEndpoint] = controlPlaneSleeping
    ? [unavailableEndpoint(), unavailableEndpoint()]
    : await Promise.all([
        probeEndpointHealth(environment.directorOrigin, fetchImpl),
        probeEndpointHealth(environment.authOrigin, fetchImpl)
      ])
  const cells = await Promise.all(environment.cells.map((cell, index) =>
    readCell(environment, cell, migValues[index] ?? null, token, fetchImpl)
  ))
  return {
    director: directorValue ? parseService(directorValue) : null,
    auth: authValue ? parseService(authValue) : null,
    sql: sqlValue ? {
      state: sqlValue.state,
      activationPolicy: sqlValue.settings.activationPolicy,
      tier: sqlValue.settings.tier,
      availabilityType: sqlValue.settings.availabilityType ?? 'unknown',
      databaseVersion: sqlValue.databaseVersion
    } : null,
    certificate: certificateValue ? {
      state: certificateValue.managed.state,
      domains: certificateValue.managed.domains,
      expireTime: certificateValue.expireTime ?? null
    } : null,
    directorEndpoint,
    authEndpoint,
    cells,
    warnings
  }
}
