import type { ConnectorAgent } from '../../shared/external-conversation-link'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from '../runtime/launched-agent-write-guard'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { sendAgentTurn } from '../runtime/orchestration/send-agent-turn'
import type { AgentPromptExpectedBinding } from '../runtime/runtime-terminal-contracts'
import { refusalOf } from './external-conversation-chain'
import { refused, type Delivery } from './external-conversation-types'

export type FollowUpTerminal = Pick<
  OrcaRuntimeService,
  'getTerminalHandleForPaneKey' | 'getTerminalPromptRequestBinding' | 'sendTerminalAgentPrompt'
> &
  LaunchedAgentWriteGuardRuntime

const UNREACHABLE = new Set([
  'terminal_not_writable',
  'terminal_handle_stale',
  'agent_not_in_foreground'
])

/** The linked pane's handle and the process it is bound to now; null once nothing is. */
export function bindPane(
  terminal: Pick<
    FollowUpTerminal,
    'getTerminalHandleForPaneKey' | 'getTerminalPromptRequestBinding'
  >,
  paneKey: string
): { handle: string; binding: AgentPromptExpectedBinding } | null {
  const handle = terminal.getTerminalHandleForPaneKey(paneKey)
  if (!handle) {
    return null
  }
  try {
    const { ptyId, processIncarnation } = terminal.getTerminalPromptRequestBinding(handle)
    return { handle, binding: { ptyId, processIncarnation } }
  } catch {
    return null
  }
}

/**
 * One follow-up through the shared writer: it waits out an approval on its own predicate, refuses
 * a process other than `expectedBinding`, and stops on `signal`. A throw before
 * any guarded write passed wrote nothing; after that it may have, so it is `unknown`.
 */
export async function deliverFollowUp(
  terminal: FollowUpTerminal,
  followUp: {
    handle: string
    expectedBinding: AgentPromptExpectedBinding
    agent: ConnectorAgent
    text: string
    requestId: string
    signal: AbortSignal
  }
): Promise<Delivery> {
  const { signal, handle, expectedBinding } = followUp
  const guard = createLaunchedAgentWriteGuard(terminal, followUp.agent, {
    unprovableHost: 'write-unless-shell'
  })
  let passes = 0
  try {
    await sendAgentTurn({
      kind: 'terminal',
      runtime: terminal,
      handle,
      turn: { purpose: 'external-message', body: followUp.text, operationId: followUp.requestId },
      beforeWrite: async (ptyId) => {
        await guard.beforeWrite(ptyId)
        // The writer's own checks after this are synchronous, so an abort cannot land between.
        if (!signal.aborted) {
          passes++
        }
      },
      onPermission: 'wait',
      expectedBinding,
      signal
    })
    return { outcome: 'accepted' }
  } catch (error) {
    if (passes === 0) {
      if (signal.aborted) {
        return refused(refusalOf(signal))
      }
      if (error instanceof Error && UNREACHABLE.has(error.message)) {
        return refused('agent_not_reachable')
      }
    }
    return { outcome: 'unknown', reason: 'writer_failed' }
  } finally {
    guard.dispose()
  }
}
