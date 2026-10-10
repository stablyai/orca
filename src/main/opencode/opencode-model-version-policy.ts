const VERIFIED_LEGACY_MODEL_VERSIONS = new Set(['1.18.30', '1.18.32', '1.18.35'])

/** Exact-version allowlist of legacy OpenCode CLIs whose real-CLI model launch behavior has been verified. */
export function isVerifiedOpenCodeLegacyModelVersion(version: string | null | undefined): boolean {
  // Plugin API compatibility alone does not verify model selection or invalid-model behavior.
  return typeof version === 'string' && VERIFIED_LEGACY_MODEL_VERSIONS.has(version)
}

/** Human-readable list of OpenCode versions that can verify launch-time model selection. */
export const VERIFIED_OPENCODE_MODEL_VERSIONS = [
  ...VERIFIED_LEGACY_MODEL_VERSIONS,
  '2.0.16' // capability-verified OpenCode 2 handled by the startup plan
].join(', ')
