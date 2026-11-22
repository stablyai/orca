import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'

/** A listing reads the account files a chat start writes, for the method saved now (right after a
 *  switch, before any chat). It never fails the listing: if the files can't be prepared, the server
 *  lists from what it has, as before; only a listing that went stale stops here. */
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
      console.warn('[acp-listing] account files not prepared for a model listing:', error)
    })
  assertCurrent()
}
