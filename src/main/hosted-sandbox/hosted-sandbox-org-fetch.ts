// fetch for Orca Cloud control-plane calls that names the team the desktop is acting for, so the
// Worker can refuse a token minted for another team (409 org_mismatch) instead of acting on it.
import type { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'

/** Header the control plane checks against the token's `org` claim. */
export const ORCA_ORG_HEADER = 'x-orca-org'
/** `x-orca-org` value for a personal account: the token must carry no org. */
export const ORCA_ORG_HEADER_PERSONAL = 'user'
export const ORG_MISMATCH = 'org_mismatch'
const STALE_TOKEN = 'stale_token'

type Refusal = 'org_mismatch' | 'stale_token' | null

async function refusalOf(response: Response): Promise<Refusal> {
  if (response.status !== 409 && response.status !== 401 && response.status !== 403) {
    return null
  }
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null)
  if (typeof body !== 'object' || body === null) {
    return null
  }
  const error = 'error' in body ? body.error : undefined
  const reason = 'reason' in body ? body.reason : undefined
  if (response.status === 409) {
    return error === ORG_MISMATCH || reason === ORG_MISMATCH ? 'org_mismatch' : null
  }
  // Token minted before this user's role or membership changed (generic 401 means signed out).
  return error === STALE_TOKEN || reason === STALE_TOKEN ? 'stale_token' : null
}

export function createOrgCheckedFetch(deps: {
  fetchImpl: typeof fetch
  /** The active team id, or `user` for a personal account; read per request. */
  orgHeader: () => string
  getAccessToken: (signal?: AbortSignal) => Promise<string>
  invalidateAccessToken: () => void
  orgSwitchError: () => EnvironmentProviderError
}): typeof fetch {
  const send = (
    input: Parameters<typeof fetch>[0],
    init: RequestInit | undefined,
    token?: string
  ): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set(ORCA_ORG_HEADER, deps.orgHeader())
    if (token !== undefined) {
      headers.set('authorization', `Bearer ${token}`)
    }
    return deps.fetchImpl(input, { ...init, headers })
  }
  return async (input, init) => {
    const response = await send(input, init)
    const refusal = await refusalOf(response)
    if (!refusal) {
      return response
    }
    // The token predates a team switch or role change: drop it, mint once more, ask again.
    console.warn(`[orca-cloud] control plane refused token (${refusal}); re-minting once`)
    await response.body?.cancel().catch(() => undefined)
    deps.invalidateAccessToken()
    const token = await deps.getAccessToken(init?.signal ?? undefined)
    const retried = await send(input, init, token)
    if ((await refusalOf(retried)) === 'org_mismatch') {
      await retried.body?.cancel().catch(() => undefined)
      throw deps.orgSwitchError()
    }
    return retried
  }
}
