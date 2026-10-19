const VERIFIED_LEGACY_MODEL_VERSIONS = new Set(['1.18.30', '1.18.32'])

export function isVerifiedOpenCodeLegacyModelVersion(version: string | null | undefined): boolean {
  // Plugin API compatibility alone does not verify model selection or invalid-model behavior.
  return typeof version === 'string' && VERIFIED_LEGACY_MODEL_VERSIONS.has(version)
}
