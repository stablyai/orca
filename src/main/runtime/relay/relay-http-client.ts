import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { E2EEKeypair } from '../e2ee-keypair'

const RelayTokenResponseSchema = z
  .object({
    relayToken: z
      .string()
      .min(1)
      .max(8 * 1024),
    expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

const AssignmentResponseSchema = z
  .object({
    v: z.literal(1),
    cellUrl: z.string().min(1).max(2048),
    assignmentEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lease: z
      .string()
      .min(1)
      .max(8 * 1024)
  })
  .strict()

export type RelayAuthorization = z.infer<typeof RelayTokenResponseSchema>
export type RelayAssignment = z.infer<typeof AssignmentResponseSchema>

export class RelayHttpError extends Error {
  constructor(
    readonly operation: 'token-exchange' | 'assignment',
    readonly statusCode: number
  ) {
    super(`relay_${operation}_failed_${statusCode}`)
  }
}

export function deriveRelayHostId(publicKey: Uint8Array): string {
  return createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
}

function isAllowedRelayOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    const loopback =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    return (
      url.origin === value && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
    )
  } catch {
    return false
  }
}

export async function exchangeRelayAuthorization(input: {
  endpoint: string
  accessToken: string
  keypair: E2EEKeypair
  fetch?: typeof globalThis.fetch
}): Promise<RelayAuthorization> {
  const relayHostId = deriveRelayHostId(input.keypair.publicKey)
  const response = await (input.fetch ?? globalThis.fetch)(input.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ relayHostId, hostPublicKeyB64: input.keypair.publicKeyB64 })
  })
  if (!response.ok) {
    throw new RelayHttpError('token-exchange', response.status)
  }
  const parsed = RelayTokenResponseSchema.safeParse(await response.json())
  if (!parsed.success) {
    throw new RelayHttpError('token-exchange', 502)
  }
  return parsed.data
}

export async function requestRelayAssignment(input: {
  directorUrl: string
  relayToken: string
  relayHostId: string
  fetch?: typeof globalThis.fetch
}): Promise<RelayAssignment> {
  if (!isAllowedRelayOrigin(input.directorUrl)) {
    throw new RelayHttpError('assignment', 400)
  }
  const response = await (input.fetch ?? globalThis.fetch)(`${input.directorUrl}/v1/assign`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${input.relayToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ v: 1, relayHostId: input.relayHostId })
  })
  if (!response.ok) {
    throw new RelayHttpError('assignment', response.status)
  }
  const parsed = AssignmentResponseSchema.safeParse(await response.json())
  if (!parsed.success || !isAllowedRelayOrigin(parsed.data.cellUrl)) {
    throw new RelayHttpError('assignment', 502)
  }
  return parsed.data
}
