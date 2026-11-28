import type { AntigravityChatAuthConfig } from '../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import { enterAcpListingGate } from './acp-listing-launch-gate'

/** An account a listing must not run on: its agent would otherwise sign in some other way. */
export class AcpListingRefused extends Error {}

/** A listing reads the account files a chat start writes, for the method saved now (right after a
 *  switch, before any chat). Files that can't be prepared never fail the listing: the server lists
 *  from what it has, as before. Only an account that refuses the listing, or a listing that went
 *  stale, stops here. */
export async function prepareAcpListingAccount(
  spec: Pick<AcpLaunchSpec, 'account' | 'launchAccount'>,
  env: Readonly<Record<string, string>>,
  antigravityChatAuth: AntigravityChatAuthConfig | undefined,
  assertCurrent: () => void
): Promise<void> {
  // Saved accounts in one home (agy's): a listing reads the selected account's models too.
  if (!antigravityChatAuth && !spec.launchAccount) {
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

/** Enters the agent's launch gate, then prepares the account as a listing does. A sign-in switch
 *  that starts meanwhile aborts the returned signal and fails `check`, so nothing spawns after it;
 *  the caller leaves the gate once its process is done. */
export async function enterAcpListingAccount(
  spec: Pick<AcpLaunchSpec, 'account' | 'launchGate' | 'launchAccount'>,
  env: Readonly<Record<string, string>>,
  antigravityChatAuth: AntigravityChatAuthConfig | undefined,
  signal: AbortSignal,
  check: () => void
) {
  const gate = enterAcpListingGate(spec.launchGate, signal)
  const gated = gate.signal ?? signal
  const current = () => {
    gated.throwIfAborted()
    check()
  }
  try {
    await prepareAcpListingAccount(spec, env, antigravityChatAuth, current)
    current()
  } catch (error) {
    gate.leave()
    throw error
  }
  return { ...gate, signal: gated }
}
