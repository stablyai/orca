import { canonicalAgentSessionDigest } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'

/** Bump when the hashed fields change, so an old digest never equals a new one by accident. */
const PROMPT_REQUEST_DIGEST_VERSION = 1

/** Digest of a provider's full request, computed before any display truncation. Callers pass what
 *  the request asks for and who asks, never transport ids, so the same request re-asked matches. */
export function journalPromptRequestDigest(
  provider: string,
  request: Record<string, unknown>
): string {
  return canonicalAgentSessionDigest({ v: PROMPT_REQUEST_DIGEST_VERSION, provider, request })
}
