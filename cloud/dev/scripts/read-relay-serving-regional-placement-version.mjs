import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SECRET = 'orca-cloud-relay-regional-placement-enabled'

function validate(input) {
  for (const key of ['project', 'region', 'service', 'bootstrap_version']) {
    if (typeof input?.[key] !== 'string' || !input[key] || /[\r\n]/.test(input[key])) {
      throw new Error(`invalid ${key}`)
    }
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(input.service)) throw new Error('invalid service')
  if (!/^[1-9][0-9]*$/.test(input.bootstrap_version)) {
    throw new Error('invalid bootstrap_version')
  }
}

export function classifyRelayServiceDescribeFailure(args, stderr) {
  const serviceDescribe = args[0] === 'run' && args[1] === 'services' && args[2] === 'describe'
  if (serviceDescribe && (stderr.includes('NOT_FOUND') || /Cannot find service \[[^\]\r\n]+\]/.test(stderr))) {
    return 'NOT_FOUND'
  }
  return 'GCLOUD_FAILED'
}

function defaultRun(args) {
  const result = spawnSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 10 * 1024 * 1024
  })
  if (result.status !== 0) {
    const error = new Error('gcloud read failed')
    error.code = classifyRelayServiceDescribeFailure(args, result.stderr)
    throw error
  }
  return JSON.parse(result.stdout)
}

function gcloudArguments(kind, input, revision) {
  return [
    'run', kind, 'describe', revision ?? input.service,
    '--project', input.project,
    '--region', input.region,
    '--format=json'
  ]
}

export function readRelayServingRegionalPlacementVersion(input, dependencies = {}) {
  validate(input)
  const run = dependencies.run ?? defaultRun
  let service
  try {
    service = run(gcloudArguments('services', input))
  } catch (error) {
    if (error?.code === 'NOT_FOUND') return { version: input.bootstrap_version }
    throw error
  }
  const serving = (service.status?.traffic ?? []).filter(
    (entry) => Number(entry.percent ?? 0) > 0
  )
  if (
    serving.length !== 1 ||
    Number(serving[0].percent) !== 100 ||
    typeof serving[0].revisionName !== 'string'
  ) {
    throw new Error('Relay director must have exactly one revision serving 100% traffic')
  }
  const revision = run(gcloudArguments('revisions', input, serving[0].revisionName))
  const references = (revision.spec?.containers ?? []).flatMap((container) =>
    (container.env ?? []).filter(
      (environment) => environment.name === 'ORCA_RELAY_REGIONAL_PLACEMENT_ENABLED'
    )
  )
  if (references.length === 0) return { version: input.bootstrap_version }
  const reference = normalizeSecretReference(references[0])
  if (
    references.length !== 1 ||
    reference?.secret !== SECRET ||
    !/^[1-9][0-9]*$/.test(reference?.version ?? '')
  ) {
    throw new Error('serving regional placement secret reference is invalid')
  }
  return { version: reference.version }
}

// Why: the v2 API reports `valueSource.secretKeyRef.{secret,version}`, but
// `gcloud run revisions describe --format=json` emits the Knative v1 shape
// `valueFrom.secretKeyRef.{name,key}`, where `name` may be a full resource path.
// A `key` of "latest" is deliberately left invalid: the director's serving
// version must be a pinned integer for this data source to mean anything.
export function normalizeSecretReference(environment) {
  const v2 = environment?.valueSource?.secretKeyRef
  if (v2) return { secret: v2.secret, version: v2.version }
  const v1 = environment?.valueFrom?.secretKeyRef
  if (!v1) return undefined
  const secret = typeof v1.name === 'string' ? v1.name.replace(/^projects\/[^/]+\/secrets\//, '') : undefined
  return { secret, version: v1.key }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  process.stdout.write(`${JSON.stringify(readRelayServingRegionalPlacementVersion(input))}\n`)
}
