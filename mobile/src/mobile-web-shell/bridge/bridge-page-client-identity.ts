/**
 * The identity a page claims, and the device identity the shell swaps in for it.
 *
 * `terminal.send` refuses a query reply whose `client.id` is not the credential the socket
 * authenticated with, so the shell, which owns the socket, resolves the placeholder on the way out.
 */

/** What a page puts in `client.id`. Fixed, so a resent message fingerprints the same caller. */
export const BRIDGE_PAGE_CLIENT_ID = 'orca-page-client'

/** `init.accepts` name for a shell that swaps. A page told nothing claims no identity at all. */
export const BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT = 'page-client-identity'

/** The two fields a page carries an identity in. `mobileClient` is native chat's spelling. */
const IDENTITY_FIELDS = ['client', 'mobileClient'] as const

/** A placeholder the shell cannot resolve. Refused rather than stripped: a request without the
 *  field is one the page did not make, and the host would read it as a different caller. */
export class BridgePageClientIdentityUnavailableError extends Error {
  readonly code = 'bridge_client_identity_unavailable'

  constructor() {
    super('this shell cannot resolve the page client identity yet')
    this.name = 'BridgePageClientIdentityUnavailableError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function claimsPageIdentity(value: unknown): boolean {
  return isRecord(value) && value.id === BRIDGE_PAGE_CLIENT_ID
}

/**
 * One method's params on their way out of the shell, with the page's placeholder resolved.
 *
 * Returns the same object when nothing claimed it, so an unchanged request replays byte-exact and
 * absent params stay absent. Throws when the shell has no identity, which both doors answer with.
 */
export function substituteBridgePageClientIdentity(
  params: unknown,
  clientIdentity: string | null
): unknown {
  if (!isRecord(params)) {
    return params
  }
  const claimed = IDENTITY_FIELDS.filter((field) => claimsPageIdentity(params[field]))
  if (claimed.length === 0) {
    return params
  }
  if (clientIdentity === null) {
    throw new BridgePageClientIdentityUnavailableError()
  }
  const next = { ...params }
  for (const field of claimed) {
    const held = params[field]
    next[field] = isRecord(held) ? { ...held, id: clientIdentity } : held
  }
  return next
}
