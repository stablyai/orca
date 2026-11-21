import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'

/** A listing reads the account files a chat start writes, for the method saved now (right after a
 *  switch, before any chat). It refuses nothing: the server's own answer stands, as before. */
export async function prepareAcpListingAccount(
  spec: Pick<AcpLaunchSpec, 'account'>,
  env: Readonly<Record<string, string>>,
  antigravityChatAuth: AntigravityChatAuthConfig | undefined,
  assertCurrent: () => void
): Promise<void> {
  if (!antigravityChatAuth) {
    return
  }
  await spec.account.prepare?.(env, antigravityChatAuth, assertCurrent, 'listing')
}
