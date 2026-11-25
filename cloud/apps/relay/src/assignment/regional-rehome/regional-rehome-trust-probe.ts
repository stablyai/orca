import { z } from 'zod'

export const REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID =
  '00000000-0000-4000-8000-000000000001'
export const REGIONAL_REHOME_TRUST_PROBE_USER_ID = 'regional-rehome-trust-probe'
export const REGIONAL_REHOME_TRUST_PROBE_HOST_ID = 'trustprobe000001'

const SOURCE_PROBE_TIMEOUT_MS = 10_000

const SourceProbeResponseSchema = z
  .object({
    v: z.literal(1),
    outcome: z.enum(['accepted', 'already-accepted', 'host-not-connected']),
    sharedRuntimeIdentityRejected: z.literal(true)
  })
  .strict()

type SourceProbeOutcome = z.infer<typeof SourceProbeResponseSchema>['outcome']

export type RegionalRehomeTrustProbeResult = {
  v: 1
  dedicatedIdentity: {
    accepted: boolean
    firstOutcome: SourceProbeOutcome
    secondOutcome: SourceProbeOutcome
    idempotent: boolean
  }
  sharedRuntimeIdentityRejected: boolean
  proven: boolean
}

export async function probeRegionalRehomeTrust(input: {
  sourceCellUrl: string
  sourceCellId: string
  sourceCellIncarnation: string
  audience: string
  identityToken: (audience: string) => Promise<string>
  fetch: typeof fetch
}): Promise<RegionalRehomeTrustProbeResult> {
  const token = await input.identityToken(input.audience)
  const body = JSON.stringify({
    v: 1,
    attemptId: REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID,
    userId: REGIONAL_REHOME_TRUST_PROBE_USER_ID,
    relayHostId: REGIONAL_REHOME_TRUST_PROBE_HOST_ID,
    sourceCellId: input.sourceCellId,
    sourceCellIncarnation: input.sourceCellIncarnation,
    sourceAssignmentEpoch: 1,
    graceMs: 0
  })
  const call = async (): Promise<z.infer<typeof SourceProbeResponseSchema>> => {
    const response = await input.fetch(
      new URL('/v1/admin/host-drain', input.sourceCellUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body,
        signal: AbortSignal.timeout(SOURCE_PROBE_TIMEOUT_MS)
      }
    )
    if (!response.ok) throw new Error(`regional_rehome_trust_probe_source_${response.status}`)
    const parsed = SourceProbeResponseSchema.safeParse(await response.json())
    if (!parsed.success) throw new Error('regional_rehome_trust_probe_source_invalid_response')
    return parsed.data
  }
  const first = await call()
  const second = await call()
  const idempotent = first.outcome === second.outcome
  const sharedRuntimeIdentityRejected =
    first.sharedRuntimeIdentityRejected && second.sharedRuntimeIdentityRejected
  const proven =
    first.outcome === 'host-not-connected' &&
    second.outcome === 'host-not-connected' &&
    idempotent &&
    sharedRuntimeIdentityRejected
  if (!proven) throw new Error('regional_rehome_trust_probe_not_proven')
  return {
    v: 1,
    dedicatedIdentity: {
      accepted: true,
      firstOutcome: first.outcome,
      secondOutcome: second.outcome,
      idempotent
    },
    sharedRuntimeIdentityRejected,
    proven
  }
}

export function isRegionalRehomeTrustProbe(input: {
  attemptId: string
  userId: string
  relayHostId: string
  sourceAssignmentEpoch: number
  graceMs: number
}): boolean {
  return (
    input.attemptId === REGIONAL_REHOME_TRUST_PROBE_ATTEMPT_ID &&
    input.userId === REGIONAL_REHOME_TRUST_PROBE_USER_ID &&
    input.relayHostId === REGIONAL_REHOME_TRUST_PROBE_HOST_ID &&
    input.sourceAssignmentEpoch === 1 &&
    input.graceMs === 0
  )
}
