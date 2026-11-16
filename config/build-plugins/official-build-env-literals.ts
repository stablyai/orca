// Official CI alone injects ORCA_BUILD_IDENTITY (stable|rc) and ORCA_POSTHOG_WRITE_KEY secrets; other builds substitute literal null.
// Compile-time substitution gates telemetry at module load without runtime env fallback; declarations live in src/types/build-constants.d.ts.
export const orcaBuildIdentity = process.env.ORCA_BUILD_IDENTITY
export const ORCA_BUILD_IDENTITY_LITERAL =
  orcaBuildIdentity === 'stable' || orcaBuildIdentity === 'rc'
    ? JSON.stringify(orcaBuildIdentity)
    : 'null'
const orcaPostHogWriteKey = process.env.ORCA_POSTHOG_WRITE_KEY
export const ORCA_POSTHOG_WRITE_KEY_LITERAL =
  typeof orcaPostHogWriteKey === 'string' && orcaPostHogWriteKey.length > 0
    ? JSON.stringify(orcaPostHogWriteKey)
    : 'null'
const orcaDiagnosticsTokenUrl = process.env.ORCA_DIAGNOSTICS_TOKEN_URL
export const ORCA_DIAGNOSTICS_TOKEN_URL_LITERAL =
  typeof orcaDiagnosticsTokenUrl === 'string' && orcaDiagnosticsTokenUrl.length > 0
    ? JSON.stringify(orcaDiagnosticsTokenUrl)
    : 'null'
