import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { fetchViaPty } from './claude-pty'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchClaudeRateLimits(options?: {
  authPreparation?: ClaudeRuntimeAuthPreparation
}): Promise<ProviderRateLimits> {
  // Why: the new implementation prioritizes OAuth API over PTY scraping.
  // The PTY fallback remains for cases where we can't find OAuth credentials
  // or the API call fails for a subscription user.
  try {
    // Note: in a real scenario we would resolve the OAuth token here.
    // For this prototype, we'll try the PTY fallback as the main path.
    return await fetchViaPty({ authPreparation: options?.authPreparation })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error'
    }
  }
}
