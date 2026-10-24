import type { EnrichedAgentHookEventPayload } from './server-types'

// Resume identity survives retiring the pane's live status claims.
export function retainedProviderSessionRow(
  entry: EnrichedAgentHookEventPayload | null | undefined
): EnrichedAgentHookEventPayload | null {
  if (
    !entry?.providerSession ||
    !entry.payload.agentType ||
    entry.payload.agentType === 'unknown'
  ) {
    return null
  }
  const { launchToken: _launchToken, ...resumeIdentity } = entry
  return { ...resumeIdentity, providerSessionOnly: true, retainedForLiveness: true }
}
