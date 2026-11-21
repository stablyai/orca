import { isAbsolute } from 'node:path'
import { z } from 'zod'
import {
  ClaudeAgentViewIdentity as Identity,
  type RegisteredClaudeAgentView
} from './agent-view-registry-file'
import {
  ClaudeAgentViewObservation,
  type ClaudeAgentViewResult,
  type ClaudeAgentViewSnapshot
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

/** The mod's config folder when Orca can read it at click time: same machine (not a WSL guest)
 *  and absolute (a relative one names the Claude's cwd, not main's). */
export function clickReadableConfigDir(
  configDir: string | undefined,
  sameMachine: boolean | undefined
): string | undefined {
  return sameMachine && configDir && isAbsolute(configDir) ? configDir : undefined
}

/** Mod instance ids start with their creation time; an older one is a delayed post from a replaced session. */
export function isOlderInstance(incoming: string, current: string): boolean {
  const [a, b] = [incoming, current].map((id) => Number(id.split('-')[0]))
  return Number.isFinite(a) && Number.isFinite(b) && a < b
}

/** What renderers see: panes whose Claude has reported a view, and which agent it shows. */
export function claudeAgentViewSnapshot(
  sessions: Iterable<RegisteredClaudeAgentView>
): ClaudeAgentViewSnapshot {
  return [...sessions].flatMap((session) =>
    session.view
      ? [
          {
            paneKey: session.paneKey,
            sessionId: session.sessionId,
            ...(session.view.agentId ? { agentId: session.view.agentId } : {})
          }
        ]
      : []
  )
}
