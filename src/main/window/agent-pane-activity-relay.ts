import type { BrowserWindow } from 'electron'

import type {
  AgentListPublication,
  AgentPaneActivityChange,
  AgentPaneActivityReply
} from '../../shared/agent-status/presentation/agent-list-status'
import { requestRendererReply } from './renderer-reply-request'

// Under the client's call timeout, so the client hears a refusal rather than losing the reply.
const AGENT_PANE_ACTIVITY_TIMEOUT_MS = 10_000

/** Asks the window to apply a client's Agents-list change and answer with the verdicts it leaves. */
export async function requestAgentPaneActivityFromRenderer(
  mainWindow: BrowserWindow,
  change: AgentPaneActivityChange
): Promise<AgentListPublication> {
  const reply = await requestRendererReply<AgentPaneActivityReply>(mainWindow, {
    requestChannel: 'ui:applyAgentPaneActivity',
    replyChannel: 'ui:agentPaneActivityReply',
    payload: change,
    timeoutMs: AGENT_PANE_ACTIVITY_TIMEOUT_MS,
    timeoutError: 'agent_activity_timeout'
  })
  if ('error' in reply) {
    throw new Error(reply.error)
  }
  return reply.publication
}
