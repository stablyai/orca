// Swap the page placeholder for the socket’s authenticated identity; terminal.send rejects query replies naming a different client.id.

// Keep the placeholder stable so resent messages fingerprint the same caller.
export const BRIDGE_PAGE_CLIENT_ID = 'orca-page-client'

const IDENTITY_FIELDS = ['client', 'mobileClient'] as const

// Refuse unresolved placeholders rather than strip them; omitting identity changes the caller the page requested.
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

// Preserve the original object/absent params when no placeholder is present for exact replay. Missing device identity throws on both request/subscription paths.
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
