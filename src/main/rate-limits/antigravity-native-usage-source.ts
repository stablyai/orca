import type { ProviderRateLimits } from '../../shared/rate-limit-types'

// Why: Antigravity has no quota source Orca can read. `agy` keeps its token in the OS keyring
// and its subcommands (agent, changelog, install, mcp, mic-serve, models, plugin,
// remote-control, update) expose no usage/quota output. Deriving this provider from Gemini's
// Code Assist quota published a different provider's pools under the Antigravity label
// (#14515) and made Antigravity usage depend on a Gemini CLI install (#9122), so this source
// reports native unavailability instead of substituting another provider.
export const ANTIGRAVITY_NO_NATIVE_SOURCE_REASON =
  'Antigravity usage is not available. Orca cannot read the Antigravity account quota pools yet.'

export function buildAntigravityNativeUnavailable(now: number = Date.now()): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: now,
    error: ANTIGRAVITY_NO_NATIVE_SOURCE_REASON,
    status: 'unavailable'
  }
}

// Why: async and argument-free like every other provider fetcher, so a real native probe can
// replace the body without moving the call site back into a derivation of another provider.
export async function fetchAntigravityRateLimits(): Promise<ProviderRateLimits> {
  return buildAntigravityNativeUnavailable()
}
