import { setTimeout as delayDefault } from 'node:timers/promises'

function integer(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function assertRelayLoadDirectorCapacityToken(config, now = Date.now, timeoutMs = 0) {
  if (!config.adminToken || config.adminToken.length > 8_192) {
    throw new Error('director capacity identity token is unavailable')
  }
  const origin = new URL(config.directorOrigin)
  if (origin.protocol !== 'https:' || origin.origin !== config.directorOrigin) {
    throw new Error('director capacity origin must be canonical HTTPS')
  }
  let claims
  try {
    const parts = config.adminToken.split('.')
    if (parts.length !== 3) throw new Error('invalid token shape')
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    throw new Error('director capacity identity token is invalid')
  }
  const expectedAudience = new URL('/v1/admin/drain', origin).toString()
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  const expiresAt = integer(claims.exp)
  if (
    !audiences.includes(expectedAudience) ||
    typeof claims.email !== 'string' ||
    claims.email.length === 0 ||
    claims.email_verified !== true ||
    expiresAt === undefined ||
    expiresAt * 1_000 <= now() + timeoutMs
  ) {
    throw new Error('director capacity identity token is not bound to this proof')
  }
}

function matchingHeartbeat(status, config) {
  const capacity = status?.connectionCapacity
  const runtime = status?.runtime
  const heartbeatAt = integer(runtime?.lastHeartbeatAt)
  const matches =
    status?.cellId === config.cellId &&
    status?.admissionState === 'general' &&
    runtime?.ready === true &&
    runtime?.heartbeatFresh === true &&
    capacity?.heartbeatFresh === true &&
    integer(capacity?.hardCap) === config.hardCap &&
    integer(capacity?.unobservedBound) === config.unobservedBound &&
    integer(capacity?.normalAdmissionPause) === config.requiredConnections &&
    integer(capacity?.observedConnections) === config.requiredConnections &&
    integer(capacity?.enforcedConnectionUnits) === config.requiredConnections &&
    integer(capacity?.inFlightConnections) === 0 &&
    integer(capacity?.reservedConnectionUnits) === 0 &&
    integer(capacity?.pendingControlReservations) === 0 &&
    heartbeatAt !== undefined
  return matches ? heartbeatAt : undefined
}

async function cellStatus(fetchImpl, config) {
  const response = await fetchImpl(`${config.directorOrigin}/v1/admin/cell-status`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.adminToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, cellId: config.cellId }),
    signal: AbortSignal.timeout(30_000)
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('director capacity identity was rejected')
  }
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined)
    return undefined
  }
  const result = await response.json().catch(() => undefined)
  if (!result?.status) throw new Error('director capacity status is invalid')
  return result.status
}

export async function waitForRelayLoadDirectorCapacity(config, overrides = {}) {
  const fetchImpl = overrides.fetch ?? fetch
  const delay = overrides.delay ?? delayDefault
  const now = overrides.now ?? Date.now
  const timeoutMs = overrides.timeoutMs ?? 120_000
  const pollMs = overrides.pollMs ?? 1_000
  assertRelayLoadDirectorCapacityToken(config, now, timeoutMs)
  const deadline = now() + timeoutMs
  let baselineHeartbeatAt = config.baselineHeartbeatAt
  let previousHeartbeatAt
  let matchingSamples = 0
  const requiredSamples = config.requiredSamples ?? 2
  for (;;) {
    const status = await cellStatus(fetchImpl, config)
    const currentHeartbeatAt = integer(status?.runtime?.lastHeartbeatAt)
    if (baselineHeartbeatAt === undefined && currentHeartbeatAt !== undefined) {
      baselineHeartbeatAt = currentHeartbeatAt
    }
    const heartbeatAt = status ? matchingHeartbeat(status, config) : undefined
    if (heartbeatAt !== undefined && heartbeatAt > baselineHeartbeatAt) {
      if (previousHeartbeatAt === undefined || heartbeatAt > previousHeartbeatAt) {
        previousHeartbeatAt = heartbeatAt
        matchingSamples++
        if (matchingSamples === requiredSamples) return { heartbeatAt }
      }
    } else {
      previousHeartbeatAt = undefined
      matchingSamples = 0
    }
    if (now() >= deadline) throw new Error('director capacity did not converge after recovery')
    await delay(pollMs)
  }
}

function matchingRequestUnits(status, config) {
  return (
    status?.cellId === config.cellId &&
    status?.admissionState === 'general' &&
    status?.capacityRequests === config.capacityRequests &&
    status?.reservedRequests === config.expectedRequestUnits &&
    status?.activityRequestUnits === config.expectedRequestUnits &&
    status?.activityLeases === config.expectedActivityLeases &&
    status?.runtime?.observedRequests === config.expectedRequestUnits &&
    status?.runtime?.ready === true &&
    status?.runtime?.heartbeatFresh === true
  )
}

export async function waitForRelayLoadRequestUnits(config, overrides = {}) {
  const fetchImpl = overrides.fetch ?? fetch
  const delay = overrides.delay ?? delayDefault
  const now = overrides.now ?? Date.now
  const timeoutMs = overrides.timeoutMs ?? config.timeoutMs ?? 120_000
  const pollMs = overrides.pollMs ?? 1_000
  const requiredSamples = overrides.requiredSamples ?? 2
  assertRelayLoadDirectorCapacityToken(config, now, timeoutMs)
  const deadline = now() + timeoutMs
  let matches = 0
  for (;;) {
    const status = await cellStatus(fetchImpl, config)
    matches = matchingRequestUnits(status, config) ? matches + 1 : 0
    if (matches === requiredSamples) return
    if (now() >= deadline) throw new Error('Relay request-unit accounting did not converge')
    await delay(pollMs)
  }
}
