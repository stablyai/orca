import { createHash, randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import type { RelayRegion } from '@orca-cloud/relay-contract/relay-regions'

// Director → relay edge admin calls. With the edge's data in its objects, the director pushes a
// host's assignment and devices before answering it with the edge, and exports them back before
// placing it anywhere else. Each call is signed with its own purpose and audience (desktops never
// receive one) and bound to the SHA-256 of its exact body.

export const EDGE_ADMIN_AUDIENCE = 'orca-relay-edge-admin'
const EDGE_ADMIN_PURPOSE = 'edge-admin'
const EDGE_ADMIN_TIMEOUT_MS = 3_000
// Calls a director makes while it holds a host's assignment row lock (the push of a move), and the
// export of a leaving host, give up sooner so a slow edge holds the lock for less.
export const EDGE_ADMIN_LOCKED_TIMEOUT_MS = 2_000

// One relay_devices row, numbers as numbers.
export type EdgeDeviceRow = {
  user_id: string
  relay_host_id: string
  relay_device_id: string
  current_hash: string
  current_version: number
  current_expires_at: number
  grace_hash: string | null
  grace_version: number | null
  grace_expires_at: number | null
  revoked_at: number | null
  updated_at: number
}

export type EdgeLocationHint = 'enam' | 'apac'

export type EdgeAssignBody = {
  userId: string
  relayHostId: string
  cellId: string
  assignmentEpoch: number
  devices?: EdgeDeviceRow[]
  locationHint?: EdgeLocationHint
}

export type EdgeAssignResult = {
  outcome: 'applied' | 'unchanged' | 'stale' | 'conflict'
  assignmentEpoch: number
}

export type EdgeExportResult =
  | { outcome: 'busy' }
  | {
      outcome: 'exported'
      assignment: { userId: string; cellId: string; assignmentEpoch: number } | null
      devices: EdgeDeviceRow[]
    }

// Drain: the edge closes the host's desktop control (DRAINING), so the desktop asks the director
// again and leaves the edge on that ask.
export type EdgeDrainResult = { outcome: 'drained'; controls: number } | { outcome: 'idle' }

export type EdgeAdminCallOptions = { timeoutMs?: number }

// A phone credential check (read-only on the edge): devices paired or rotated while the host is on
// the edge live only in its object. not_here: the object does not hold the host (moved, frozen).
export type EdgeVerifyBody = { relayHostId: string; kind: 'resume' | 'invite'; tokenHash: string }
export type EdgeVerifyResult =
  | { outcome: 'verified'; userId: string; relayDeviceId: string; assignmentEpoch: number }
  | { outcome: 'none' }
  | { outcome: 'not_here' }

export interface EdgeAdmin {
  assign(body: EdgeAssignBody, options?: EdgeAdminCallOptions): Promise<EdgeAssignResult>
  exportHost(relayHostId: string): Promise<EdgeExportResult>
  drain(relayHostId: string): Promise<EdgeDrainResult>
  // Optional so a fake without it reads as an edge without the op (today's 401).
  verify?(body: EdgeVerifyBody): Promise<EdgeVerifyResult>
}

// The edge did not give a usable answer (network, timeout, 5xx, auth); the caller retries later.
export class EdgeAdminUnavailableError extends Error {
  constructor(reason: string) {
    super(`relay_edge_admin_unavailable:${reason}`)
  }
}

// Objects never move, so the first push decides where a host's object lives.
// A host answered through a front door (its clients are where the front door serves) is placed in
// apac whatever region it asked for. Only an object's first placement reads it.
export function edgeLocationHint(region: RelayRegion | undefined, viaFrontDoor = false): EdgeLocationHint {
  return region === 'asia-east2' || viaFrontDoor ? 'apac' : 'enam'
}

export function createEdgeAdmin(options: {
  cellUrl: string
  signingKey: Uint8Array
  issuer: string
  fetch?: typeof fetch
  timeoutMs?: number
}): EdgeAdmin {
  const send = options.fetch ?? fetch
  const call = async (
    op: 'assign' | 'export' | 'drain' | 'verify',
    body: unknown,
    timeoutMs = options.timeoutMs ?? EDGE_ADMIN_TIMEOUT_MS
  ): Promise<{ status: number; json: unknown }> => {
    const raw = JSON.stringify(body)
    const token = await new SignJWT({
      purpose: EDGE_ADMIN_PURPOSE,
      op,
      bodySha256: createHash('sha256').update(raw).digest('base64url')
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(options.issuer)
      .setAudience(EDGE_ADMIN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1m')
      // Unique per call, so the edge can refuse a replayed token.
      .setJti(randomBytes(16).toString('base64url'))
      .sign(options.signingKey)
    let response: Response
    try {
      response = await send(`${options.cellUrl}/__admin/${op}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: raw,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch {
      throw new EdgeAdminUnavailableError('network')
    }
    // 409 carries a decision (stale, conflict, busy); anything else that is not 200 is unusable.
    if (response.status !== 200 && response.status !== 409) {
      await response.body?.cancel()
      throw new EdgeAdminUnavailableError(`status_${response.status}`)
    }
    try {
      return { status: response.status, json: await response.json() }
    } catch {
      throw new EdgeAdminUnavailableError('body')
    }
  }
  return {
    async assign(body, callOptions) {
      const { json } = await call('assign', body, callOptions?.timeoutMs)
      const result = json as Partial<EdgeAssignResult>
      if (
        !['applied', 'unchanged', 'stale', 'conflict'].includes(String(result.outcome)) ||
        !Number.isSafeInteger(result.assignmentEpoch)
      ) {
        throw new EdgeAdminUnavailableError('assign_answer')
      }
      return result as EdgeAssignResult
    },
    async exportHost(relayHostId) {
      const timeoutMs = Math.min(options.timeoutMs ?? EDGE_ADMIN_TIMEOUT_MS, EDGE_ADMIN_LOCKED_TIMEOUT_MS)
      const { json } = await call('export', { relayHostId }, timeoutMs)
      const result = json as Partial<{ outcome: string; devices: unknown; assignment: unknown }>
      if (result.outcome === 'busy') return { outcome: 'busy' }
      if (result.outcome !== 'exported' || !Array.isArray(result.devices)) {
        throw new EdgeAdminUnavailableError('export_answer')
      }
      return result as EdgeExportResult
    },
    // An edge from before the op answers 404, which throws EdgeAdminUnavailableError like any outage.
    async verify(body) {
      const { status, json } = await call('verify', body)
      const result = json as Partial<{ outcome: string; userId: unknown; relayDeviceId: unknown; assignmentEpoch: unknown }>
      if (status === 200 && (result.outcome === 'none' || result.outcome === 'not_here')) {
        return { outcome: result.outcome }
      }
      if (
        status !== 200 ||
        result.outcome !== 'verified' ||
        typeof result.userId !== 'string' ||
        typeof result.relayDeviceId !== 'string' ||
        !Number.isSafeInteger(result.assignmentEpoch)
      ) {
        throw new EdgeAdminUnavailableError('verify_answer')
      }
      return {
        outcome: 'verified',
        userId: result.userId,
        relayDeviceId: result.relayDeviceId,
        assignmentEpoch: result.assignmentEpoch as number
      }
    },
    async drain(relayHostId) {
      const { status, json } = await call('drain', { relayHostId })
      const result = json as Partial<{ outcome: string; controls: unknown }>
      if (status === 200 && result.outcome === 'idle') return { outcome: 'idle' }
      if (status !== 200 || result.outcome !== 'drained' || !Number.isSafeInteger(result.controls)) {
        throw new EdgeAdminUnavailableError('drain_answer')
      }
      return { outcome: 'drained', controls: result.controls as number }
    }
  }
}
