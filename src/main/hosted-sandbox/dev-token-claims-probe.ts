// GH-LIST-MISSING diagnostics, dev builds only: which org the Orca Cloud token in use claims, next
// to the team the app shows. A token minted for another team (or none) explains an empty GitHub
// list after an owner → member → owner switch. Never the token itself, and never in packaged builds.

type ClaimsProbe = () => Promise<{ org: string | null; orgRole: string | null; sub: string | null }>

/** Reads the claims of a JWT's payload without verifying it; nothing else of the token leaves. */
export function tokenOrgClaims(token: string): Awaited<ReturnType<ClaimsProbe>> {
  const payload = token.split('.')[1]
  let claims: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'))
    if (parsed && typeof parsed === 'object') {
      claims = { ...parsed }
    }
  } catch {
    // Not a JWT: report nothing rather than guess.
  }
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)
  return { org: text(claims.org), orgRole: text(claims.org_role), sub: text(claims.sub) }
}

/**
 * Dev builds: `globalThis.__orcaCloudTokenClaims()` in the main process (the harness's inspector)
 * answers the org, role and user the current sandbox token claims.
 */
export function installDevTokenClaimsProbe(
  getAccessToken: () => Promise<string>,
  packaged: boolean
): ClaimsProbe | null {
  if (packaged) {
    return null
  }
  const probe: ClaimsProbe = async () => tokenOrgClaims(await getAccessToken())
  Object.assign(globalThis, { __orcaCloudTokenClaims: probe })
  return probe
}
