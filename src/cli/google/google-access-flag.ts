// `orca google connect --access`: the level asked for, once the host says it can sign in with it.
import type { GoogleStatusView } from '../../shared/google/google-connect-types'
import { GOOGLE_ACCESS_LEVELS, type GoogleAccess } from '../../shared/google/google-scopes'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'

function readAccess(value: string): GoogleAccess {
  const access = GOOGLE_ACCESS_LEVELS.find((level) => level === value.trim().toLowerCase())
  if (!access) {
    throw new RuntimeClientError(
      'invalid_argument',
      `--access takes ${GOOGLE_ACCESS_LEVELS.join(' or ')}, not ${value}.`
    )
  }
  return access
}

/** An older host drops an `access` it doesn't know and grants full, so read-draft needs it listed. */
export async function readHostAccess(
  ctx: HandlerContext,
  value: string | undefined
): Promise<GoogleAccess | undefined> {
  if (value === undefined) {
    return undefined
  }
  const access = readAccess(value)
  if (access === 'full') {
    return access
  }
  const { result } = await ctx.client.call<GoogleStatusView>('google.status', {})
  if (!result.accessLevels?.includes(access)) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Orca on this host can't sign in with --access ${access}; it would grant full access instead. Update Orca there first.`
    )
  }
  return access
}
