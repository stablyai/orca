import type {
  AntigravityAccountState,
  AntigravityAccountTarget
} from '../../../../../shared/agent-accounts/antigravity/antigravity-account-types'
import { isAntigravityHostAccountHome } from '../../../../antigravity/antigravity-host-acp'
import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredAgentHostAlternativeReady } from '../../../agent-session/launch/structured-agent-launch-support'
import type { OrcaRuntimeService } from '../../../orca-runtime'

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
  const chatUsesAgy = await structuredAgentHostAlternativeReady('antigravity', runtime).catch(
    () => null
  )
  return chatUsesAgy === null ? state : { ...state, chatUsesAgy }
}

/** A running `agy acp` may keep the login it started with, so idle chats on agy stop and resume on
 *  the newly selected account at their next send; busy ones keep their turn (#43375). */
export function restartIdleAgyChats(target: AntigravityAccountTarget): void {
  const host = getStructuredAgentSessionHost()
  if (!host || target.runtime !== 'host') {
    return
  }
  for (const id of host.loadedSessionIds()) {
    const home = host.sessionAgent(id) === 'antigravity' ? host.childAccountHome(id) : undefined
    if (home && isAntigravityHostAccountHome(home)) {
      void host.releaseIdleSession(id, true).catch((error: unknown) => {
        console.warn('[antigravity] an idle chat kept the previous account:', error)
      })
    }
  }
}
