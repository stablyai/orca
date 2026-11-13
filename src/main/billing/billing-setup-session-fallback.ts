import type { OrcaBillingCheckoutArgs } from '../../shared/orca-billing'

/** A setup session for another team or user (or an expired one) must not block buying. */
export async function withSetupSessionFallback<T extends { status: string; error?: string }>(
  args: OrcaBillingCheckoutArgs,
  run: (args: OrcaBillingCheckoutArgs) => Promise<T>
): Promise<T> {
  const result = await run(args)
  if (
    args.setupSessionId &&
    result.status === 'failed' &&
    /setup_session_mismatch/.test(result.error ?? '')
  ) {
    const { setupSessionId: _dropped, ...plain } = args
    return run(plain)
  }
  return result
}
