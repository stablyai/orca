import {
  computeTrustedHash,
  computeTrustKey,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'

/**
 * How Codex will treat an Orca entry this install wrote:
 * - 'trusted': the stored hash matches the entry;
 * - 'untrusted': no stored hash, so Codex lists it for review;
 * - 'stale': a stored hash for other content at that slot; Codex lists it as modified;
 * - 'disabled': the user turned it off.
 */
export type OrcaEntryTrust = 'trusted' | 'untrusted' | 'stale' | 'disabled'

export function readOrcaEntryTrust(
  entry: CodexTrustEntry,
  trustStates: ReadonlyMap<string, CodexHookTrustState>
): OrcaEntryTrust {
  const state = trustStates.get(computeTrustKey(entry))
  if (state?.enabled === false) {
    return 'disabled'
  }
  if (state?.trustedHash === undefined) {
    return 'untrusted'
  }
  return state.trustedHash === computeTrustedHash(entry) ? 'trusted' : 'stale'
}
