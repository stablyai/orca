// Preserves machine-shared Claude Code OAuth integrations (MCP connector tokens) across
// an Orca-driven account switch.
//
// Why (orca#16098): writeActiveClaudeKeychainCredentialsForRuntime overwrites the global
// "Claude Code-credentials" Keychain item with exactly the target managed account's own
// stored credential (see runtime-auth-sync.ts). That credential is captured at account-add
// time and never carries sibling keys Orca itself doesn't know about — in particular
// `mcpOAuth` (MCP server OAuth connections: Claude Code's own third-party plugin
// integrations), which live on the credential object but are not per-account, they are
// shared by whichever Claude Code account happens to be active on the machine. Every
// switch therefore silently drops any MCP connections the previous session had, because
// the target's stored blob never had them to begin with.
//
// This mirrors an external tool (claude-swap, https://github.com/scaryghost/claude-swap)
// that manages account switching for the same global Keychain item and already treats
// these keys as machine-shared: on every switch it reads the *live* credential (the one
// about to be replaced), pulls this same key set off it, and merges those fields into the
// account it's switching to — live-wins, absence included, because a slot's own frozen
// copy of a shared field can hold an already-rotated-out refresh token. Applying the same
// rule here, at the same point in the write path, makes Orca-driven and cswap-driven
// switches converge on the same result instead of only one of them preserving MCP state.
export const SHARED_CLAUDE_CREDENTIAL_KEYS = [
  'mcpOAuth',
  'mcpOAuthClientConfig',
  'mcpXaaIdp',
  'mcpXaaIdpConfig',
  'pluginSecrets'
] as const

function parseCredentialObject(credentialsJson: string | null): Record<string, unknown> | null {
  if (!credentialsJson) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(credentialsJson)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  return parsed as Record<string, unknown>
}

/**
 * Compose the credential to write to the global Keychain item from its two owners: the
 * target account's own fields, and the live credential's copy of the machine-shared
 * fields (present or absent — absence is authoritative for these keys, matching
 * claude-swap's documented rationale that a target's frozen copy may be stale).
 *
 * Returns `targetCredentialsJson` unchanged when either side isn't a parseable Claude
 * OAuth credential object (a managed API key, or a malformed/missing value) — this
 * function only ever adjusts the known shared-key set, never anything else.
 */
export function mergeSharedClaudeCredentialFields(
  targetCredentialsJson: string,
  liveCredentialsJson: string | null
): string {
  const target = parseCredentialObject(targetCredentialsJson)
  const live = parseCredentialObject(liveCredentialsJson)
  if (!target || !('claudeAiOauth' in target) || !live) {
    return targetCredentialsJson
  }

  const merged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(target)) {
    if (!(SHARED_CLAUDE_CREDENTIAL_KEYS as readonly string[]).includes(key)) {
      merged[key] = value
    }
  }
  for (const key of SHARED_CLAUDE_CREDENTIAL_KEYS) {
    if (key in live) {
      merged[key] = live[key]
    }
  }

  // Why: read-back detection treats any byte diff from the last write as an external
  // refresh; only reformat (dropping e.g. a trailing newline) when the merge is non-empty.
  if (JSON.stringify(merged) === JSON.stringify(target)) {
    return targetCredentialsJson
  }
  return JSON.stringify(merged)
}
