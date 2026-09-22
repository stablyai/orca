/**
 * The identity a page claims, and the device identity the shell swaps in for it.
 *
 * The page holds no pairing credential and must not: `init` carries the host minus the token by
 * the same rule that keeps it out of AsyncStorage. But the host does not treat `client.id` as an
 * opaque key — `terminal.send` refuses a query reply whose `client.id` is not the credential the
 * socket authenticated with — so a page-chosen id is a spoof to it. The shell owns the socket, so
 * the shell owns the substitution, and it happens in the one place page params leave the shell.
 */

/**
 * What a page puts in `client.id`. Fixed and non-secret, never a per-document value: the composer's
 * send journal fingerprints its caller with this, and an id that rotated per mount would refuse a
 * resent message as a different caller.
 */
export const BRIDGE_PAGE_CLIENT_ID = 'orca-page-client'

/**
 * `init.accepts` name for a shell that performs the swap. A page served by a shell that names none
 * claims no identity at all, so the placeholder never reaches a host that would read it as a spoof.
 */
export const BRIDGE_PAGE_CLIENT_IDENTITY_ACCEPT = 'page-client-identity'

/** The two fields a page carries an identity in. `mobileClient` is native chat's spelling. */
const IDENTITY_FIELDS = ['client', 'mobileClient'] as const

function claimsPageIdentity(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { id?: unknown }).id === BRIDGE_PAGE_CLIENT_ID
  )
}

/**
 * One method's params on their way out of the shell, with the page's placeholder resolved.
 *
 * Returns the same object when nothing claimed the placeholder, so a request the page sent
 * unchanged is replayed byte-exact and an absent `params` stays absent. An identity the shell
 * cannot read yet drops the field rather than forwarding the placeholder: the host reads a missing
 * `client` as a pre-identity mobile caller, which is a degradation, where the placeholder would be
 * a refusal.
 */
export function substituteBridgePageClientIdentity(
  params: unknown,
  clientIdentity: string | null
): unknown {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return params
  }
  const held = params as Record<string, unknown>
  const claimed = IDENTITY_FIELDS.filter((field) => claimsPageIdentity(held[field]))
  if (claimed.length === 0) {
    return params
  }
  const next = { ...held }
  for (const field of claimed) {
    if (clientIdentity === null) {
      delete next[field]
      continue
    }
    next[field] = { ...(held[field] as Record<string, unknown>), id: clientIdentity }
  }
  return next
}
