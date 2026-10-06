import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import { sessionWriteUnreadReplySchema } from './session-write-reply-schema'
import {
  agentSessionRefusalCauseParts,
  agentSessionWriteNoticeEnglish
} from '../../../src/shared/agent-session-refusal-notice'
import {
  agentSessionRefusalFailure,
  readAgentSessionErrorRefusal
} from '../../../src/shared/agent-session-write-failure'
import type { RpcFailure } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileAgentSessionTerminalOpen } from './mobile-agent-session-terminal-actions'

/**
 * Handing a structured Chat's own conversation to a terminal. The host owns the resume argv and
 * mints the tab, so the reply body is unread: the new tab arrives through the strip's own sync.
 */
export const agentSessionTerminalOpenRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'terminal.open-agent-session',
    method: 'terminal.ensureAgentSession',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('terminal-agent-session-open', sessionWriteUnreadReplySchema)
  })
)

export const AGENT_SESSION_TERMINAL_OPEN_FAILED = "Couldn't open this chat in a terminal"

/** The agent's own startup budget; the host spawns a process behind this call. */
const AGENT_SESSION_TERMINAL_OPEN_TIMEOUT_MS = 15_000

/**
 * The words for a refused open. The host refuses with its bare code, so a refusal that names a
 * reason supplies the sentence through the same pipeline a refused chat start uses — this surface
 * has already said what did not happen. Otherwise the host's own message stands where it says
 * more than the code, and this surface's sentence where it does not.
 */
function openFailureText(response: RpcFailure): string {
  const refusal = readAgentSessionErrorRefusal(response.error)
  const cause = refusal
    ? agentSessionWriteNoticeEnglish(
        agentSessionRefusalCauseParts(agentSessionRefusalFailure(refusal))
      )
    : ''
  if (cause) {
    return cause
  }
  const message = response.error.message.trim()
  return message && message !== response.error.code ? message : AGENT_SESSION_TERMINAL_OPEN_FAILED
}

export async function openMobileAgentSessionInTerminal(
  client: RpcClient,
  target: { worktreeId: string } & MobileAgentSessionTerminalOpen
): Promise<void> {
  const response = await agentSessionTerminalOpenRun.request(
    client,
    {
      kind: 'explicit',
      worktree: `id:${target.worktreeId}`,
      agent: target.agent,
      providerSession: target.providerSession,
      // Why: the phone renders its own mirror; a host with no renderer cannot focus one.
      presentation: 'background'
    },
    { timeoutMs: AGENT_SESSION_TERMINAL_OPEN_TIMEOUT_MS }
  )
  // The reader admits any payload, so this policy declines exactly the refused replies.
  if (agentSessionTerminalOpenRun.interpret(response).accepted || response.ok) {
    return
  }
  throw new Error(openFailureText(response))
}
