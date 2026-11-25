// mvp-object.ts checks (local only) for single-use admin tokens (jti) and the rotation key.
import { randomBytes } from 'node:crypto'
import { EPOCH, NEXT_SIGNING_KEY, USER, adminCall, adminSend, adminToken, newHost, record, sha } from './harness-mvp-object'

function device(relayHostId: string, relayDeviceId: string) {
  const now = Date.now()
  return {
    user_id: USER,
    relay_host_id: relayHostId,
    relay_device_id: relayDeviceId,
    current_hash: sha(randomBytes(32).toString('base64url')),
    current_version: 1,
    current_expires_at: now + 24 * 60 * 60 * 1000,
    grace_hash: null,
    grace_version: null,
    grace_expires_at: null,
    revoked_at: null,
    updated_at: now
  }
}

const deviceIds = (json: Record<string, unknown> | null) =>
  ((json?.devices ?? []) as { relay_device_id: string }[]).map((d) => d.relay_device_id).sort().join(',')

// P5: a captured admin token is single use. Its replay is 409 `replay` and changes nothing (a
// same-epoch assign with devices would otherwise reset the host's device set).
export async function replayCheck(): Promise<void> {
  const id = newHost().relayHostId
  const first = { userId: USER, relayHostId: id, cellId: 'edge', assignmentEpoch: EPOCH, devices: [device(id, 'device-r1')] }
  const firstToken = await adminToken('assign', first)
  const applied = await adminSend('assign', first, firstToken)
  const replayed = await adminSend('assign', first, firstToken)
  record('P5 assign applied; the same token again is 409 replay', applied.json?.outcome === 'applied' && replayed.status === 409 && replayed.json?.outcome === 'replay', `${applied.json?.outcome}/${replayed.status}:${replayed.json?.outcome}`)
  const second = { ...first, devices: [device(id, 'device-r1'), device(id, 'device-r2')] }
  const retried = await adminCall('assign', second)
  const replayedLater = await adminSend('assign', first, firstToken)
  const exportBody = { relayHostId: id }
  const exportToken = await adminToken('export', exportBody)
  const exported = await adminSend('export', exportBody, exportToken)
  const exportReplay = await adminSend('export', exportBody, exportToken)
  record(
    'P5 a distinct jti is accepted; a later replay does not reset the devices; export replay 409',
    retried.status === 200 && retried.json?.outcome === 'unchanged' && replayedLater.status === 409 && deviceIds(exported.json) === 'device-r1,device-r2' && exportReplay.status === 409 && exportReplay.json?.outcome === 'replay',
    `${retried.json?.outcome}/${replayedLater.status} devices=${deviceIds(exported.json)} exportReplay=${exportReplay.status}:${exportReplay.json?.outcome}`
  )

  // Two copies of one token racing: the host's object lets exactly one through.
  const raceId = newHost().relayHostId
  const raceBody = { userId: USER, relayHostId: raceId, cellId: 'edge', assignmentEpoch: EPOCH, devices: [] }
  const raceToken = await adminToken('assign', raceBody)
  const race = await Promise.all([adminSend('assign', raceBody, raceToken), adminSend('assign', raceBody, raceToken)])
  const statuses = race.map((r) => r.status).sort().join(',')
  record('P5 two concurrent copies of one token: one 200, one 409 replay', statuses === '200,409', statuses)

  // Drain: replay of a drain on a pushed host is refused; an idle drain of a host nobody pushed
  // records nothing (no storage), so it stays idle.
  const drainBody = { relayHostId: raceId }
  const drainToken = await adminToken('drain', drainBody)
  const drains = [await adminSend('drain', drainBody, drainToken), await adminSend('drain', drainBody, drainToken)]
  const strayBody = { relayHostId: newHost().relayHostId }
  const strayToken = await adminToken('drain', strayBody)
  const strays = [await adminSend('drain', strayBody, strayToken), await adminSend('drain', strayBody, strayToken)]
  record(
    'P5 drain replay on a pushed host 409; idle drain of an unpushed host is not recorded',
    drains[0].json?.outcome === 'idle' && drains[1].status === 409 && strays.every((r) => r.status === 200 && r.json?.outcome === 'idle'),
    `${drains.map((r) => `${r.status}:${r.json?.outcome}`).join('/')} stray=${strays.map((r) => r.status).join('/')}`
  )

  // Transitional: a token without a jti is still accepted (ADMIN_REQUIRE_JTI off).
  const legacyId = newHost().relayHostId
  const legacy = await adminCall('assign', { userId: USER, relayHostId: legacyId, cellId: 'edge', assignmentEpoch: EPOCH, devices: [] }, { jti: null })
  const shortJti = await adminCall('assign', { userId: USER, relayHostId: legacyId, cellId: 'edge', assignmentEpoch: EPOCH }, { jti: 'short' })
  record('P5 no jti accepted (transitional); a malformed jti is 401', legacy.json?.outcome === 'applied' && shortJti.status === 401, `${legacy.json?.outcome}/${shortJti.status}`)
}

// P6: key rotation. The edge accepts ADMIN_SIGNING_KEY_NEXT as well as the primary.
export async function rotationCheck(): Promise<void> {
  const id = newHost().relayHostId
  const body = { userId: USER, relayHostId: id, cellId: 'edge', assignmentEpoch: EPOCH, devices: [] }
  const next = await adminCall('assign', body, { key: NEXT_SIGNING_KEY })
  const primary = await adminCall('assign', body)
  const other = await adminCall('assign', body, { key: randomBytes(36).toString('base64url') })
  record('P6 NEXT key accepted, primary still accepted, any other key 401', next.json?.outcome === 'applied' && primary.json?.outcome === 'unchanged' && other.status === 401, `${next.json?.outcome}/${primary.json?.outcome}/${other.status}`)
}
