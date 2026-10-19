import { createHash } from 'node:crypto'
import { decodeProtectedHeader, errors, jwtVerify } from 'jose'
import { z } from 'zod'

export const ASSIGNMENT_LEASE_AUDIENCE = 'orca-relay-cell'
const MAX_LEASE_LENGTH = 4 * 1024

// Names the signing key so a later rotation can verify both keys by id. Not a secret: it is a
// truncated hash of one.
export function assignmentLeaseKeyId(key: Uint8Array): string {
  return `k1-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`
}

export type AssignmentLeaseClass =
  | 'valid'
  | 'absent'
  | 'expired'
  | 'bad-signature'
  | 'wrong-host'
  | 'wrong-cell'
  | 'epoch-behind'
  | 'epoch-ahead'

const LeaseClaimsSchema = z.object({
  purpose: z.literal('cell-assignment'),
  sub: z.string(),
  cellId: z.string(),
  assignmentEpoch: z.number().int(),
  relayHostId: z.string()
})

// Classifies the lease a host echoed against the hello it sent. Never throws.
export async function classifyAssignmentLease(input: {
  lease: string | undefined
  key: Uint8Array
  cellId: string
  userId: string
  relayHostId: string
  helloEpoch: number
}): Promise<AssignmentLeaseClass> {
  if (!input.lease) return 'absent'
  if (input.lease.length > MAX_LEASE_LENGTH) return 'bad-signature'
  try {
    // Leases from directors that predate the key id carry none; the one key verifies them.
    const kid = decodeProtectedHeader(input.lease).kid
    if (kid !== undefined && kid !== assignmentLeaseKeyId(input.key)) return 'bad-signature'
    const { payload } = await jwtVerify(input.lease, input.key, {
      audience: ASSIGNMENT_LEASE_AUDIENCE,
      algorithms: ['HS256']
    })
    const claims = LeaseClaimsSchema.safeParse(payload)
    if (!claims.success) return 'bad-signature'
    if (claims.data.sub !== input.userId || claims.data.relayHostId !== input.relayHostId) {
      return 'wrong-host'
    }
    if (claims.data.cellId !== input.cellId) return 'wrong-cell'
    if (claims.data.assignmentEpoch < input.helloEpoch) return 'epoch-behind'
    if (claims.data.assignmentEpoch > input.helloEpoch) return 'epoch-ahead'
    return 'valid'
  } catch (error) {
    return error instanceof errors.JWTExpired ? 'expired' : 'bad-signature'
  }
}
