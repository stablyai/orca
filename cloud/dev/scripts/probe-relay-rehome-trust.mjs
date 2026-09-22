import { pathToFileURL } from 'node:url'
import { fetchAdminOnceMore } from './relay-admin-transient-retry.mjs'

// Every general cell that carries the rehome identity: the sixteen US cells and the
// three asia-east2 cells that drain mis-homed hosts back the other way.
const PRODUCTION_CELL = /^production-gce-c(?:7|8|9|10|13|14|15|16|19|20|21|22|23|24|25|26|27|28|29)$/
const DIRECTOR_ORIGIN = 'https://relay.onorca.dev'

export function parseRehomeTrustProbeArguments(argv, environment = process.env) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) throw new Error('invalid arguments')
    values[key.slice(2)] = value
  }
  for (const key of ['director-origin', 'cell-id', 'cell-incarnation']) {
    if (!values[key]) throw new Error(`missing --${key}`)
  }
  if (values['director-origin'] !== DIRECTOR_ORIGIN) {
    throw new Error('--director-origin must be the production Relay origin')
  }
  if (!PRODUCTION_CELL.test(values['cell-id'])) throw new Error('--cell-id is not approved')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    values['cell-incarnation']
  )) throw new Error('--cell-incarnation is invalid')
  const token = environment.ORCA_RELAY_ADMIN_ID_TOKEN
  if (!token || token.length > 8_192 || !/^[^.]+\.[^.]+\.[^.]+$/.test(token)) {
    throw new Error('admin identity token is unavailable')
  }
  return {
    directorOrigin: DIRECTOR_ORIGIN,
    cellId: values['cell-id'],
    cellIncarnation: values['cell-incarnation'],
    token
  }
}

export async function probeRehomeTrust(config, dependencies = {}) {
  const fetchImpl = dependencies.fetch ?? fetch
  const request = () => fetchAdminOnceMore(
    fetchImpl,
    `${config.directorOrigin}/v1/admin/regional-rehome-trust-probe`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        v: 1,
        sourceCellId: config.cellId,
        sourceCellIncarnation: config.cellIncarnation
      })
    },
    { wait: dependencies.wait }
  )
  let response = await request()
  let body = await response.json().catch(() => ({}))
  // The director wraps source HTTP failures in 409; retry only explicit transient statuses.
  if (response.status === 409 && /^regional_rehome_trust_probe_source_(500|502|503|504)$/.test(body?.error ?? '')) {
    await (dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(2_000)
    response = await request()
    body = await response.json().catch(() => ({}))
  }
  if (!response.ok) {
    const safeReasons = new Set([
      'invalid_token', 'director_only', 'invalid_request',
      'regional_rehome_trust_not_configured',
      'regional_rehome_trust_probe_source_unavailable',
      'regional_rehome_trust_probe_source_invalid_response',
      'regional_rehome_trust_probe_not_proven',
      ...[400, 401, 403, 404, 409, 429, 500, 502, 503, 504]
        .map((status) => `regional_rehome_trust_probe_source_${status}`)
    ])
    const reason = safeReasons.has(body?.error) ? body.error : 'unrecognized_error'
    throw new Error(`application-mediated rehome trust probe returned ${response.status}: ${reason}`)
  }
  if (
    body.v !== 1 ||
    body.dedicatedIdentity?.firstOutcome !== 'host-not-connected' ||
    body.dedicatedIdentity?.secondOutcome !== 'host-not-connected' ||
    body.dedicatedIdentity?.accepted !== true ||
    body.dedicatedIdentity?.idempotent !== true ||
    body.sharedRuntimeIdentityRejected !== true ||
    body.proven !== true
  ) throw new Error('application-mediated rehome trust proof is incomplete')
  return body
}

export async function main(argv = process.argv.slice(2)) {
  const result = await probeRehomeTrust(parseRehomeTrustProbeArguments(argv))
  process.stdout.write(`${JSON.stringify({ event: 'relay_rehome_trust_verified', ...result })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
