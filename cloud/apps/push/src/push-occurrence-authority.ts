import { PushRouteCurrentSchema, type PushNotification } from '@orca-cloud/push-contract'
import type { PushDatabase, SqlRow } from './push-database.js'
import { createHash } from 'node:crypto'
import type { CoveredPushBatch } from './push-queued-dismissal.js'

export function pushDestination(device: {
  platform: string
  token: string
  apnsEnvironment?: string
}): string {
  return createHash('sha256')
    .update(JSON.stringify([device.platform, device.apnsEnvironment ?? '', device.token]))
    .digest('hex')
}

export type OccurrenceIdentity = [string, string, string, string]
export type OccurrenceDomain = { destination: string; routeKey: string }
export const occurrenceLock = (identity: OccurrenceIdentity): string =>
  `push-claim:${JSON.stringify(identity)}`
export const occurrenceIdentity = (
  domain: OccurrenceDomain,
  notification: PushNotification
): OccurrenceIdentity | undefined =>
  notification.origin && notification.occurrence
    ? [domain.destination, domain.routeKey, notification.origin, notification.occurrence]
    : undefined

// The caller already owns sender/queue; registry writers never take route ownership.
export async function occurrenceTarget(
  tx: PushDatabase,
  host: string,
  registrationId: string,
  nonblocking = false
): Promise<{ device: SqlRow; domain?: OccurrenceDomain } | 'deferred' | undefined> {
  const share = tx.dialect === 'postgres' ? ` FOR SHARE${nonblocking ? ' SKIP LOCKED' : ''}` : ''
  const [device] = await tx.query(
    `SELECT * FROM push_devices WHERE registration_id = ? AND host_fingerprint = ?${share}`,
    [registrationId, host]
  )
  if (!device) {
    if (
      nonblocking &&
      (
        await tx.query(
          'SELECT registration_id FROM push_devices WHERE registration_id = ? AND host_fingerprint = ?',
          [registrationId, host]
        )
      ).length
    ) {
      return 'deferred'
    }
    return undefined
  }
  if (device.dead_at != null || typeof device.route_key !== 'string') {
    return { device }
  }
  const destination = pushDestination({
    platform: String(device.platform),
    token: String(device.token),
    ...(device.apns_environment ? { apnsEnvironment: String(device.apns_environment) } : {})
  })
  if (nonblocking) {
    if (!(await tx.tryLockScope(`push-routes:${destination}`))) {
      return 'deferred'
    }
  } else {
    await tx.lockScope(`push-routes:${destination}`)
  }
  const params = [destination, device.route_key]
  const [declaration] = await tx.query(
    `SELECT version, hosts_json FROM push_route_declarations WHERE destination = ? AND route_key = ?${share}`,
    params
  )
  if (!declaration) {
    if (
      nonblocking &&
      (
        await tx.query(
          'SELECT destination FROM push_route_declarations WHERE destination = ? AND route_key = ?',
          params
        )
      ).length
    ) {
      return 'deferred'
    }
    return { device }
  }
  if (
    typeof declaration.hosts_json !== 'string' ||
    Buffer.byteLength(declaration.hosts_json) > 1901
  ) {
    throw new Error('Corrupt route declaration hosts')
  }
  const current = PushRouteCurrentSchema.parse({
    status: 'current',
    version: Number(declaration.version),
    hosts: JSON.parse(declaration.hosts_json)
  })
  return {
    device,
    ...(current.hosts.includes(host) ? { domain: { destination, routeKey: device.route_key } } : {})
  }
}

export async function fenceDismissedOccurrences(
  tx: PushDatabase,
  host: string,
  registrationId: string,
  covered: CoveredPushBatch[],
  now: number,
  nonblocking = false
): Promise<boolean> {
  if (!covered.some(({ notification: n }) => n.origin && n.occurrence)) {
    return true
  }
  const target = await occurrenceTarget(tx, host, registrationId, nonblocking)
  if (target === 'deferred') {
    return false
  }
  const identities = new Map<string, OccurrenceIdentity>()
  const add = (domain: OccurrenceDomain, notification: PushNotification) => {
    const identity = occurrenceIdentity(domain, notification)
    if (identity) {
      identities.set(occurrenceLock(identity), identity)
    }
  }
  if (target?.domain) {
    for (const batch of covered) {
      add(target.domain, batch.notification)
    }
  }
  const batches = new Map(
    covered.flatMap((batch) => (batch.id ? [[batch.id, batch] as const] : []))
  )
  const ids = [...batches.keys()]
  // Chunk only the covered batch PKs, never scan another sender's admissions.
  for (let offset = 0; offset < ids.length; offset += 100) {
    const chunk = ids.slice(offset, offset + 100)
    const rows = await tx.query(
      `SELECT a.batch_id, a.destination, a.route_key FROM push_batch_admissions a
      JOIN push_delivery_batches b ON b.batch_id = a.batch_id
      WHERE a.batch_id IN (${chunk.map(() => '?').join(',')})
      AND b.host_fingerprint = ? AND b.registration_id = ? AND b.kind = 'alert'
      AND b.state = 'pending' AND b.expires_at > ?`,
      [...chunk, host, registrationId, now]
    )
    for (const row of rows) {
      const batch = batches.get(String(row.batch_id))
      if (batch) {
        add(
          { destination: String(row.destination), routeKey: String(row.route_key) },
          batch.notification
        )
      }
    }
  }
  const ordered = [...identities].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [key] of ordered) {
    if (nonblocking) {
      if (!(await tx.tryLockScope(key))) {
        return false
      }
    } else {
      await tx.lockScope(key)
    }
  }
  for (const [, identity] of ordered) {
    await tx.query(
      `INSERT INTO push_occurrence_domains(destination, route_key, origin, occurrence, state, lease_until, created_at)
      VALUES (?, ?, ?, ?, 'dismissed', 0, ?)
      ON CONFLICT(destination, route_key, origin, occurrence) DO UPDATE SET state = 'dismissed',
      created_at = CASE WHEN push_occurrence_domains.state = 'dismissed' THEN push_occurrence_domains.created_at ELSE excluded.created_at END`,
      [...identity, now]
    )
  }
  return true
}
