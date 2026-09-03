import { pathToFileURL } from 'node:url'

const PRODUCTION_CELL = /^production-gce-c(?:7|8|9|10|13|14|15|16|19|20|21|22|23|24|25|26)$/
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
  const response = await fetchImpl(
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
      }),
      signal: AbortSignal.timeout(30_000)
    }
  )
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`application-mediated rehome trust probe returned ${response.status}`)
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
