import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const WINDOW_MS = 24 * 60 * 60_000
const BUCKET_MS = 60 * 60_000
const METRICS = [
  'requestedRegionsDelta',
  'selectedRegionsDelta',
  'regionFallbacksDelta',
  'unavailableRegionsDelta'
]
const REGION_KEYS = new Set(['asia-east2', 'us-central1', 'unhinted'])

function integer(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`)
  return parsed
}

function digest(value, name) {
  if (!/^sha256:[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`${name} is invalid`)
  return value
}

function metric(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} is invalid`)
  }
  return Object.fromEntries(Object.entries(value).map(([key, count]) => {
    if (!REGION_KEYS.has(key)) throw new Error(`${name} has an unknown aggregate key`)
    return [key, integer(count, `${name}.${key}`)]
  }))
}

function sumMetric(total, value) {
  for (const [key, count] of Object.entries(value)) total[key] = (total[key] ?? 0) + count
}

function evidenceSha256(evidence) {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
}

export function createRegionObservationEvidence(entries, bindings, now = Date.now()) {
  if (!Array.isArray(entries)) throw new Error('runtime metrics response must be an array')
  if (!/^[0-9a-f]{40}$/.test(bindings.commitSha ?? '')) throw new Error('commit SHA is invalid')
  const directorImageDigest = digest(bindings.directorImageDigest, 'director digest')
  const selectorGeneration = integer(bindings.selectorGeneration, 'selector generation')
  const controlGeneration = integer(bindings.controlGeneration, 'control generation')
  const start = now - WINDOW_MS
  const buckets = Array.from({ length: 24 }, () => 0)
  const totals = Object.fromEntries(METRICS.map((name) => [name, {}]))
  let samples = 0
  for (const entry of entries) {
    const timestamp = Date.parse(entry?.timestamp ?? '')
    const payload = entry?.jsonPayload
    if (
      !Number.isFinite(timestamp) ||
      timestamp < start ||
      timestamp > now + 60_000 ||
      payload?.event !== 'orca_relay_runtime_metrics' ||
      payload.role !== 'director'
    ) continue
    const bucket = Math.min(23, Math.floor((timestamp - start) / BUCKET_MS))
    buckets[bucket] += 1
    samples += 1
    for (const name of METRICS) sumMetric(totals[name], metric(payload[name], name))
  }
  if (buckets.some((count) => count === 0)) {
    throw new Error('24-hour region evidence has a missing hourly bucket')
  }
  if (
    !Number.isSafeInteger(totals.requestedRegionsDelta['asia-east2']) ||
    totals.requestedRegionsDelta['asia-east2'] < 1 ||
    !Number.isSafeInteger(totals.selectedRegionsDelta['asia-east2']) ||
    totals.selectedRegionsDelta['asia-east2'] < 1
  ) throw new Error('24-hour region evidence has no Asia request and selection activity')
  const evidence = {
    v: 1,
    commitSha: bindings.commitSha,
    directorImageDigest,
    selectorGeneration,
    controlGeneration,
    windowStartedAt: start,
    windowEndedAt: now,
    hourlySampleCounts: buckets,
    samples,
    totals
  }
  return { evidence, sha256: evidenceSha256(evidence) }
}

export function verifyRegionObservationEvidence(sealed, bindings) {
  if (
    sealed?.sha256 !== evidenceSha256(sealed?.evidence) ||
    sealed.evidence?.commitSha !== bindings.commitSha ||
    sealed.evidence?.directorImageDigest !== bindings.directorImageDigest ||
    sealed.evidence?.selectorGeneration !== Number(bindings.selectorGeneration) ||
    sealed.evidence?.controlGeneration !== Number(bindings.controlGeneration) ||
    !Array.isArray(sealed.evidence?.hourlySampleCounts) ||
    sealed.evidence.hourlySampleCounts.length !== 24 ||
    sealed.evidence.hourlySampleCounts.some((count) => integer(count, 'bucket') < 1) ||
    integer(sealed.evidence?.totals?.requestedRegionsDelta?.['asia-east2'], 'Asia requests') < 1 ||
    integer(sealed.evidence?.totals?.selectedRegionsDelta?.['asia-east2'], 'Asia selections') < 1
  ) throw new Error('sealed 24-hour region evidence does not match enable authority')
  return sealed.evidence
}

function values(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith('--') || argv[index + 1] === undefined) {
      throw new Error('invalid arguments')
    }
    result[argv[index].slice(2)] = argv[index + 1]
  }
  return result
}

async function stdinJson(input) {
  const chunks = []
  for await (const chunk of input) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function main(argv = process.argv.slice(2), input = process.stdin) {
  const command = argv.shift()
  const args = values(argv)
  const bindings = {
    commitSha: args['commit-sha'],
    directorImageDigest: args['director-image-digest'],
    selectorGeneration: args['selector-generation'],
    controlGeneration: args['control-generation']
  }
  if (command === 'create') {
    const sealed = createRegionObservationEvidence(await stdinJson(input), bindings)
    process.stdout.write(`${JSON.stringify(sealed)}\n`)
    return
  }
  if (command === 'verify') {
    verifyRegionObservationEvidence(JSON.parse(readFileSync(args.file, 'utf8')), bindings)
    return
  }
  throw new Error('unknown region observation evidence command')
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
