import { z } from 'zod'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import {
  ClaudeAgentViewObservation,
  type ClaudeAgentViewResult
} from '../../../shared/agent-hook-listener/providers/claude/view/claude-agent-view'

export const Identity = z.object({
  paneKey: z
    .string()
    .max(256)
    .refine((value) => parsePaneKey(value) !== null),
  sessionId: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256)
})
export const Message = z.discriminatedUnion('action', [
  Identity.extend({
    action: z.literal('register'),
    keybindings: z.string().max(128 * 1024),
    view: ClaudeAgentViewObservation.optional()
  }),
  Identity.extend({ action: z.literal('renew'), view: ClaudeAgentViewObservation.optional() }),
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

export type ViewSession = z.infer<typeof Identity> & {
  chord: string
  keybindings: string
  seenAt: number
  pending?: PendingView
  view?: z.infer<typeof ClaudeAgentViewObservation>
}

export type BridgeReply = {
  registered?: true
  renew?: true
  requestId?: string
  agentId?: string
  expiresAt?: number
}
