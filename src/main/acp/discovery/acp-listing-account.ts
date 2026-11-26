import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'

/** An account a listing must not run on: its agent would otherwise sign in some other way. */
export class AcpListingRefused extends Error {}

/** A listing reads the account files a chat start writes, for the method saved now (right after a
 *  switch, before any chat). Files that can't be prepared never fail the listing: the server lists
 *  from what it has, as before. Only an account that refuses the listing, or a listing that went
 *  stale, stops here. */
export async function prepareAcpListingAccount(
  spec: Pick<AcpLaunchSpec, 'account'>,
  env: Readonly<Record<string, string>>,
  antigravityChatAuth: AntigravityChatAuthConfig | undefined,
  assertCurrent: () => void
): Promise<void> {
  if (!antigravityChatAuth) {
    return
  }
  await spec.account
    .prepare?.(env, antigravityChatAuth, assertCurrent, 'listing')
    .catch((error: unknown) => {
      if (error instanceof AcpListingRefused) {
        throw error
      }
      console.warn('[acp-listing] account files not prepared for a model listing:', error)
    })
  assertCurrent()
}
