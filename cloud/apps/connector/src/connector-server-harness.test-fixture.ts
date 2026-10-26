import { randomBytes, randomUUID } from 'node:crypto'
import { openCloudNotifications, type CloudDatabase } from '@orca-cloud/cloud-database'
import { CONNECTOR_PATHS } from '@orca-cloud/connector-contract'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import pg from 'pg'
import type { ConnectorConfig } from './config.js'
import { openConnectorDatabase, openInMemoryConnectorDatabase } from './connector-database.js'
import { createConnectorServer } from './connector-server.js'
import { connectorHostId } from './connector-token-verifier.js'

export const PUBLIC_URL = 'https://connector.onorca.dev'
export const AUTH_ISSUER = 'https://login.onorca.dev'
export const HOST_IP = '203.0.113.7'

// Real Postgres when the CI service is present; each harness gets its own schema.
const testDatabaseUrl = process.env.ORCA_CONNECTOR_TEST_DATABASE_URL

export function testConnectorConfig(): ConnectorConfig {
  return {
    mode: 'active',
    port: 0,
    publicUrl: PUBLIC_URL,
    dataDir: './data/connector-test',
    databasePoolMax: 4,
    authIssuer: AUTH_ISSUER,
    jwksUrl: `${AUTH_ISSUER}/.well-known/jwks.json`,
    trustedProxyHops: 0
  }
}

const cleanups: (() => Promise<void>)[] = []
export async function cleanupConnectorHarnesses(): Promise<void> {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
}

async function openTestDatabase(): Promise<{ database: CloudDatabase; databaseUrl?: string }> {
  if (!testDatabaseUrl) {
    const database = await openInMemoryConnectorDatabase()
    cleanups.push(() => database.close())
    return { database }
  }
  const admin = new pg.Client({ connectionString: testDatabaseUrl })
  await admin.connect()
  const schema = `connector_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const url = new URL(testDatabaseUrl)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const database = await openConnectorDatabase({ databaseUrl: url.toString(), dataDir: '', poolMax: 4 })
  cleanups.push(async () => {
    await database.close()
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await admin.end()
  })
  return { database, databaseUrl: url.toString() }
}

// Stands in for the auth service's connector token route.
async function testTokenIssuer() {
  const { privateKey, publicKey } = await generateKeyPair('ES256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'ES256' }
  return {
    jwks: createLocalJWKSet({ keys: [jwk] }),
    sign: async (claims: { sub: string; mid: string }, expiresAtSeconds: number) =>
      await new SignJWT({ prof: 'profile-1', sid: 'family-1', mid: claims.mid, purpose: 'connector-host' })
        .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
        .setIssuer(AUTH_ISSUER)
        .setAudience('orca-connector')
        .setSubject(claims.sub)
        .setIssuedAt()
        .setExpirationTime(expiresAtSeconds)
        .sign(privateKey)
  }
}

// Holds the first transaction statement starting with `prefix` until release(), locks still held.
// `skip` lets that many matching statements through first.
export function pauseBefore(database: CloudDatabase, prefix: string, skip = 0) {
  let reached!: () => void
  const atStatement = new Promise<void>((resolve) => (reached = resolve))
  let release!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  let seen = 0
  const wrap = (inner: CloudDatabase): CloudDatabase => ({
    dialect: inner.dialect,
    query: async (sql, params) => {
      if (sql.trimStart().startsWith(prefix) && seen++ === skip) {
        reached()
        await released
      }
      return await inner.query(sql, params)
    },
    transaction: (run) => inner.transaction((transaction) => run(wrap(transaction))),
    lockQuotaScope: (key) => inner.lockQuotaScope(key),
    tryLockScope: (key) => inner.tryLockScope(key),
    tryLockSharedScope: (key) => inner.tryLockSharedScope(key),
    close: () => inner.close()
  })
  return { database: wrap(database), atStatement, release }
}

export async function createConnectorHarness(
  config: Partial<ConnectorConfig> = {},
  options: {
    pollHoldMs?: number
    wrapDatabase?: (database: CloudDatabase) => CloudDatabase
  } = {}
) {
  let now = 1_800_000_000_000
  const issuer = await testTokenIssuer()
  const { database, databaseUrl } = await openTestDatabase()
  const notifications = openCloudNotifications(databaseUrl ? { databaseUrl } : {})
  const runtime = createConnectorServer(
    { ...testConnectorConfig(), ...config },
    options.wrapDatabase?.(database) ?? database,
    notifications,
    { now: () => now, jwks: issuer.jwks, pollHoldMs: options.pollHoldMs ?? 0 }
  )
  await runtime.waker.start()
  cleanups.push(() => runtime.waker.close())
  const request = (path: string, init?: RequestInit): Promise<Response> =>
    Promise.resolve(runtime.app.request(path, init))
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': HOST_IP, ...headers },
      body: JSON.stringify(body)
    })

  // A signed-in machine holding a connector token, with helpers for the machine API.
  async function machine(
    account = 'user-1',
    { machineId = randomBytes(16).toString('base64url'), ttlSeconds = 300 } = {}
  ) {
    const claims = { sub: account, mid: machineId }
    const expiresAt = (Math.floor(Date.now() / 1000) + ttlSeconds) * 1000
    const token = await issuer.sign(claims, expiresAt / 1000)
    const call = (path: string, body: unknown, method = 'POST') =>
      request(path, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': HOST_IP,
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body)
      })
    return {
      hostId: connectorHostId(claims),
      machineId,
      expiresAt,
      call,
      hello: (helloRev = 1) =>
        call(
          CONNECTOR_PATHS.hello,
          {
            v: 1,
            helloRev,
            contract: 1,
            hostName: 'build-box',
            platform: 'linux',
            runtime: 'serve',
            orcaVersion: '1.4.230',
            agents: ['claude'],
            promptKinds: ['approval'],
            features: ['answer', 'cancel'],
            projects: []
          },
          'PUT'
        ),
      poll: async (helloRev = 1) => {
        const response = await call(CONNECTOR_PATHS.poll, { v: 1, helloRev })
        const body: unknown = await response.json()
        return { status: response.status, body }
      },
      ack: (acks: unknown[], helloRev = 1) => call(CONNECTOR_PATHS.acks, { v: 1, helloRev, acks })
    }
  }

  return {
    runtime,
    database,
    machine,
    request,
    json,
    advance: (ms: number) => {
      now += ms
    },
    now: () => now
  }
}
