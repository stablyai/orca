import { z } from 'zod'
import { ClaudeAgentViewIdentity as Identity } from './agent-view-registry-file'
import {
  ClaudeAgentViewObservation,
  type ClaudeAgentViewResult
} from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

export const ClaudeAgentViewMessage = z.discriminatedUnion('action', [
  Identity.extend({
    action: z.literal('register'),
    keybindings: z.string().max(128 * 1024),
    configDir: z.string().min(1).max(4096).optional(),
    view: ClaudeAgentViewObservation.optional()
  }),
  Identity.extend({ action: z.literal('observe'), view: ClaudeAgentViewObservation }),
  Identity.extend({ action: z.literal('take') }),
  Identity.extend({
    action: z.literal('ack'),
    requestId: z.string().max(64),
    deny: z.string().max(1024).optional()
  }),
  Identity.extend({ action: z.literal('end') })
])

export type PendingView = {
  requestId: string
  agentId?: string
  expiresAt: number
  taken: boolean
  finish: (result: ClaudeAgentViewResult) => void
}

export type ClaudeAgentViewReply = {
  registered?: true
  durable?: true
  observed?: true
  unbound?: true
  unknown?: true
  requestId?: string
  agentId?: string
  expiresAt?: number
}

/** The mod's take (claim the request) or ack (report the switch) for a pane's waiting view. */
export function answerPendingView(
  request: PendingView | undefined,
  message: z.infer<typeof ClaudeAgentViewMessage>
): ClaudeAgentViewReply {
  if (!request) {
    return {}
  }
  if (message.action === 'take') {
    if (request.taken || request.expiresAt < Date.now()) {
      return {}
    }
    request.taken = true
    return { requestId: request.requestId, agentId: request.agentId, expiresAt: request.expiresAt }
  }
  if (message.action === 'ack' && request.taken && message.requestId === request.requestId) {
    request.finish(message.deny ? { status: 'denied', reason: message.deny } : { status: 'viewed' })
  }
  return {}
}
