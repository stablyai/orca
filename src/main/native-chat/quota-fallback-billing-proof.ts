import { z } from 'zod'
import type { NativeQuotaFallbackConfig } from './quota-fallback-native-config'

const BillingProof = z.object({
  evidenceId: z.string().min(1),
  pool: z.string().min(1),
  credentialRef: z.string().min(1),
  sessionId: z.string().min(1),
  sourceTurnId: z.string().min(1),
  product: z.enum(['orca-claude-native', 'orca-codex-native']),
  funding: z.literal('free-grant'),
  productEligible: z.literal(true),
  autoRecharge: z.literal(false),
  paidOverflowBlocked: z.literal(true),
  enforcement: z.literal('atomic-run-cap'),
  maxDebitUsd: z.number().finite().positive(),
  observedAt: z.number().finite(),
  expiresAt: z.number().finite()
})
export type NativeQuotaBillingProof = z.infer<typeof BillingProof>

/** The trusted adapter must obtain evidence from enforcement, not synthesize it from a budget setting. */
export async function readVerifiedQuotaBilling(
  config: NativeQuotaFallbackConfig,
  input: Parameters<NativeQuotaFallbackConfig['verify']>[0],
  now: () => number
): Promise<Awaited<ReturnType<NativeQuotaFallbackConfig['verify']>>> {
  const value = await config.verify(input)
  const parsed = BillingProof.safeParse(value?.billingProof)
  if (!value || !parsed.success) {
    return null
  }
  const proof = parsed.data
  const time = now()
  const product = input.record.provider === 'claude' ? 'orca-claude-native' : 'orca-codex-native'
  if (
    !Number.isFinite(time) ||
    proof.observedAt > time ||
    time - proof.observedAt > 60_000 ||
    proof.expiresAt <= time ||
    proof.pool !== value.pool ||
    proof.credentialRef !== value.credentialRef ||
    proof.sessionId !== input.cut.sessionId ||
    proof.sourceTurnId !== input.cut.turnItemId ||
    proof.product !== product
  ) {
    return null
  }
  return {
    ...value,
    billingProof: proof,
    candidates: value.candidates.map((candidate) => {
      if (candidate.route === 'antigravity-opus') {
        return { ...candidate }
      }
      const credit = candidate.credit
      return {
        ...candidate,
        available: candidate.available && credit?.maxDebitUsd === proof.maxDebitUsd,
        observedAt: Math.min(candidate.observedAt, proof.observedAt),
        credit: credit
          ? { ...credit, expiresAt: Math.min(credit.expiresAt, proof.expiresAt) }
          : undefined
      }
    })
  }
}
