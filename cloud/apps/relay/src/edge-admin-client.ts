import { createHash } from 'node:crypto'
import { SignJWT } from 'jose'
import type { RelayRegion } from '@orca-cloud/relay-contract/relay-regions'

// Director → relay edge admin calls. With the edge's data in its objects, the director pushes a
// host's assignment and devices before answering it with the edge, and exports them back before
// placing it anywhere else. Each call is signed with its own purpose and audience (desktops never
// receive one) and bound to the SHA-256 of its exact body.

export const EDGE_ADMIN_AUDIENCE = 'orca-relay-edge-admin'
const EDGE_ADMIN_PURPOSE = 'edge-admin'
const EDGE_ADMIN_TIMEOUT_MS = 3_000

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

export interface EdgeAdmin {
  assign(body: EdgeAssignBody): Promise<EdgeAssignResult>
  exportHost(relayHostId: string): Promise<EdgeExportResult>
}

// The edge did not give a usable answer (network, timeout, 5xx, auth); the caller retries later.
export class EdgeAdminUnavailableError extends Error {
  constructor(reason: string) {
    super(`relay_edge_admin_unavailable:${reason}`)
  }
}

// Objects never move, so the first push decides where a host's object lives.
export function edgeLocationHint(region: RelayRegion | undefined): EdgeLocationHint {
  return region === 'asia-east2' ? 'apac' : 'enam'
}

export function createEdgeAdmin(options: {
  cellUrl: string
  signingKey: Uint8Array
  issuer: string
  fetch?: typeof fetch
  timeoutMs?: number
}): EdgeAdmin {
  const send = options.fetch ?? fetch
  const call = async (op: 'assign' | 'export', body: unknown): Promise<{ status: number; json: unknown }> => {
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
      .sign(options.signingKey)
    let response: Response
    try {
      response = await send(`${options.cellUrl}/__admin/${op}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: raw,
        signal: AbortSignal.timeout(options.timeoutMs ?? EDGE_ADMIN_TIMEOUT_MS)
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
    async assign(body) {
      const { json } = await call('assign', body)
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
      const { json } = await call('export', { relayHostId })
      const result = json as Partial<{ outcome: string; devices: unknown; assignment: unknown }>
      if (result.outcome === 'busy') return { outcome: 'busy' }
      if (result.outcome !== 'exported' || !Array.isArray(result.devices)) {
        throw new EdgeAdminUnavailableError('export_answer')
      }
      return result as EdgeExportResult
    }
  }
}
