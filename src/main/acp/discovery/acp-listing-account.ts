import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { AgentModelCatalogUnavailableError } from '../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { AgentSessionAcquisitionRefusal } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'

/** A listing reads the account files a chat start writes, for the method saved now (right after a
 *  switch, before any chat); an account that can't sign in lists nothing, as a signed-out agent. */
export async function prepareAcpListingAccount(
  spec: Pick<AcpLaunchSpec, 'account'>,
  env: Readonly<Record<string, string>>,
  antigravityChatAuth: AntigravityChatAuthConfig | undefined,
  assertCurrent: () => void
): Promise<void> {
  if (!antigravityChatAuth) {
    return
  }
  await spec.account.prepare?.(env, antigravityChatAuth, assertCurrent).catch((error: unknown) => {
    throw error instanceof AgentSessionAcquisitionRefusal && error.reason === 'notSignedIn'
      ? new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
      : error
  })
}
