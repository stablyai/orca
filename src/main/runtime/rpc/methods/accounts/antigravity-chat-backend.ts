import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import {
  forgetAntigravityHostAcpChecks,
  isAntigravityHostAccountHome,
  readyAntigravityHostAcpVersion
} from '../../../../antigravity/antigravity-host-acp'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredAgentHostAlternativeReady } from '../../../agent-session/launch/structured-agent-launch-support'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { withTimeout } from '../../../../../shared/concurrency/promise-timeout-fallback'

const CHAT_BACKEND_WAIT_MS = 1_500

/** Adds whether new chats on this host run on agy, and so on the account these rows switch. */
export async function withAntigravityChatBackend(
  runtime: OrcaRuntimeService,
  target: AntigravityAccountTarget,
  state: AntigravityAccountState
): Promise<AntigravityAccountState> {
  // Chats never run in WSL.
  if (target.runtime !== 'host') {
    return state
  }
  // A cold agy check takes seconds; the rows don't wait for it, and a later refresh shows it.
  const chatUsesAgy = await withTimeout<boolean | null>(
    structuredAgentHostAlternativeReady('antigravity', runtime),
    CHAT_BACKEND_WAIT_MS,
    null
  )
  if (chatUsesAgy === null) {
    return state
  }
  const version = chatUsesAgy ? readyAntigravityHostAcpVersion() : null
  return { ...state, chatUsesAgy, ...(version ? { chatAgyVersion: version } : {}) }
}

/** A running `agy acp` may keep the login it started with, so idle chats on agy stop and resume on
 *  the newly selected account at their next send; busy ones keep their turn (#43375). */
export function restartIdleAgyChats(target: AntigravityAccountTarget): void {
  if (target.runtime !== 'host') {
    return
  }
  // The cached answer vouched for the previous login.
  forgetAntigravityHostAcpChecks()
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return
  }
  for (const id of host.loadedSessionIds()) {
    const home =
      host.sessionAgent(id) === 'antigravity' ? host.childAccountHome(id, true) : undefined
    if (home && isAntigravityHostAccountHome(home)) {
      void host.releaseIdleSession(id, true).catch((error: unknown) => {
        console.warn('[antigravity] an idle chat kept the previous account:', error)
      })
    }
  }
}
