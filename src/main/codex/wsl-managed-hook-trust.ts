import { computeTrustKey, readHookTrustEntries, type CodexTrustEntry } from './config-toml-trust'
import { getCodexHookTrustSignature } from './codex-hook-identity'

export type WslManagedHookTrustCandidate = {
  next: CodexTrustEntry
  previous: CodexTrustEntry | null
}

/** Keeps Codex-authored trust only while a managed WSL hook's content is unchanged. */
export function preserveCodexWrittenWslManagedHookTrust(
  tomlPath: string,
  candidates: readonly WslManagedHookTrustCandidate[]
): CodexTrustEntry[] {
  const existingTrust = readHookTrustEntries(tomlPath)
  return candidates.map(({ next, previous }) => {
    if (
      !previous ||
      computeTrustKey(previous) !== computeTrustKey(next) ||
      getCodexHookTrustSignature(previous) !== getCodexHookTrustSignature(next)
    ) {
      return next
    }
    const state = existingTrust.get(computeTrustKey(previous))
    if (!state?.trustedHash) {
      return next
    }
    // Why: Codex is authoritative for its trust hash. Keep its approval only
    // when the installed hook content and key are unchanged across reinstall.
    return {
      ...next,
      trustedHash: state.trustedHash,
      ...(state.enabled !== undefined ? { enabled: state.enabled } : {})
    }
  })
}
