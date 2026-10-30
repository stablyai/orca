import nacl from 'tweetnacl'
import {
  pushRouteDeclarationContent,
  PushRouteCurrentSchema,
  type PushRouteDeclaration,
  type PushRouteCurrent
} from '@orca-cloud/push-contract'
import type { PushDatabase } from './push-database.js'
import { pushDestination } from './push-occurrence-admission.js'

type RouteResult =
  | { status: 200; body: PushRouteCurrent | { status: 'accepted'; version: number } }
  | {
      status: 401 | 403 | 409
      body: { error: 'invalid_signature' | 'no_live_registration' | 'conflict' }
    }
export async function declarePushRoutes(
  database: PushDatabase,
  value: PushRouteDeclaration,
  now: number
): Promise<RouteResult> {
  const publicKey = Buffer.from(value.routeKey, 'base64url')
  const signature = Buffer.from(value.signature, 'base64url')
  if (
    publicKey.toString('base64url') !== value.routeKey ||
    signature.toString('base64url') !== value.signature ||
    !nacl.sign.detached.verify(
      Buffer.from(pushRouteDeclarationContent(value)),
      signature,
      publicKey
    )
  ) {
    return { status: 401, body: { error: 'invalid_signature' } }
  }
  const destination = pushDestination(value)
  return database.transaction<RouteResult>(async (tx) => {
    await tx.lockScope(`push-routes:${destination}`)
    const [device] = await tx.query(
      "SELECT registration_id FROM push_devices WHERE platform = ? AND token = ? AND COALESCE(apns_environment, '') = ? AND route_key = ? AND dead_at IS NULL LIMIT 1",
      [value.platform, value.token, value.apnsEnvironment ?? '', value.routeKey]
    )
    if (!device) {
      return { status: 403, body: { error: 'no_live_registration' } }
    }
    const lock = value.action === 'replace' && tx.dialect === 'postgres' ? ' FOR UPDATE' : ''
    const [previous] = await tx.query(
      `SELECT version, hosts_json FROM push_route_declarations WHERE destination = ? AND route_key = ?${lock}`,
      [destination, value.routeKey]
    )
    if (
      previous &&
      (typeof previous.hosts_json !== 'string' || Buffer.byteLength(previous.hosts_json) > 1901)
    ) {
      throw new Error('Corrupt route declaration hosts')
    }
    const parsed = PushRouteCurrentSchema.safeParse(
      previous
        ? {
            status: 'current',
            version: Number(previous.version),
            hosts:
              typeof previous.hosts_json === 'string' ? JSON.parse(previous.hosts_json) : undefined
          }
        : { status: 'current', version: null, hosts: [] }
    )
    if (!parsed.success) {
      throw new Error('Corrupt route declaration')
    }
    const current = parsed.data
    if (value.action === 'read') {
      return { status: 200, body: current }
    }
    const hosts = JSON.stringify([...new Set(value.hosts)].sort())
    if (current.version === value.version && JSON.stringify(current.hosts) === hosts) {
      return { status: 200, body: { status: 'accepted', version: value.version } }
    }
    if (
      current.version !== value.expectedVersion ||
      (current.version !== null && value.version <= current.version)
    ) {
      return { status: 409, body: { error: 'conflict' } }
    }
    await tx.query(
      `INSERT INTO push_route_declarations(destination, route_key, version, hosts_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(destination, route_key) DO UPDATE SET version = excluded.version, hosts_json = excluded.hosts_json, updated_at = excluded.updated_at`,
      [destination, value.routeKey, value.version, hosts, now]
    )
    return { status: 200, body: { status: 'accepted', version: value.version } }
  })
}
