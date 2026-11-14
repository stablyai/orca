import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { AGENT_TOOL_DECISION_HEADER } from '../tool-events/agent-tool-plugin-hooks'

/** Sent by hook scripts that wait for, and print, Orca's answer to a Claude Code PermissionRequest. */
export const CLAUDE_PERMISSION_REQUEST_DECISION = 'claude-permission-request-v1'
// Why 122 s: past Claude's 2:00 auto-block, inside the script's 126 s curl and the entry's 130 s timeout.
export const CLAUDE_PERMISSION_HOLD_BUDGET_MS = 122_000

export type ClaudePermissionVerdict = { behavior: 'allow' } | { behavior: 'deny'; message: string }

/** Why a hold ended without Orca's decision: the budget ran out, the hook hung up first, or Orca quit. */
export type ClaudePermissionHoldEnd = 'budget' | 'hook-gone' | 'quit'

/** One waiting PermissionRequest hook: exactly one reply ever reaches it. */
export type ClaudePermissionHookChannel = {
  /** Writes the hook's only reply; null passes (`{}`). True once the whole reply left for the hook. */
  answer: (verdict: ClaudePermissionVerdict | null) => Promise<boolean>
  /** Runs once if the hold ends before any `answer`. */
  onEnd: (listener: (why: ClaudePermissionHoldEnd) => void) => void
}

export type ClaudePermissionHold = {
  event: AgentHookEventPayload
  /** Claude's own id for the user prompt this request belongs to. */
  promptId: string | undefined
  /** Holds the hook's request open; call only when keeping it. */
  openChannel: () => ClaudePermissionHookChannel
}

/** The runtime's side: keeps a hold it can answer (true); otherwise Orca answers as it always has. */
export type ClaudePermissionHolds = {
  admit: (hold: ClaudePermissionHold) => boolean
  observe: (event: AgentHookEventPayload) => void
}

export function claudePermissionReply(verdict: ClaudePermissionVerdict | null): string {
  if (!verdict) {
    return '{}'
  }
  // Never updatedPermissions: an answer covers this one request only.
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: verdict }
  })
}

/** Holds the hook's request open; the budget, a hang-up and quit all end it with `{}`. */
export function openClaudePermissionHookChannel(
  req: IncomingMessage,
  res: ServerResponse,
  budgetMs = CLAUDE_PERMISSION_HOLD_BUDGET_MS
): ClaudePermissionHookChannel & { drain: () => void } {
  let replied = false
  const endListeners: ((why: ClaudePermissionHoldEnd) => void)[] = []
  const end = (why: ClaudePermissionHoldEnd): void => {
    for (const listener of endListeners.splice(0)) {
      listener(why)
    }
  }
  const write = (verdict: ClaudePermissionVerdict | null): Promise<boolean> => {
    if (replied || res.writableEnded || res.destroyed) {
      return Promise.resolve(false)
    }
    replied = true
    clearTimeout(budget)
    return new Promise((resolve) => {
      res.once('finish', () => resolve(true))
      res.once('close', () => resolve(res.writableFinished))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(claudePermissionReply(verdict))
    })
  }
  // The body is read; the budget, not the 5 s slowloris cap, bounds the rest.
  req.setTimeout(budgetMs + 5_000, () => req.destroy())
  const budget = setTimeout(() => {
    void write(null)
    end('budget')
  }, budgetMs)
  budget.unref?.()
  res.once('close', () => {
    if (!replied) {
      replied = true
      clearTimeout(budget)
      end('hook-gone')
    }
  })
  return {
    answer: (verdict) => {
      endListeners.length = 0
      return write(verdict)
    },
    onEnd: (listener) => {
      endListeners.push(listener)
    },
    drain: () => {
      void write(null)
      end('quit')
    }
  }
}

/** The hook server's side: hands a worker's PermissionRequest to the runtime, and answers every waiting one `{}` at quit. */
export class ClaudePermissionHookHolds {
  private holds: ClaudePermissionHolds | null = null
  private readonly drains = new Set<() => void>()

  set(holds: ClaudePermissionHolds | null): void {
    this.holds = holds
  }

  /** True when the runtime kept the request; otherwise the server answers as it always has. */
  hold(req: IncomingMessage, res: ServerResponse, event: AgentHookEventPayload): boolean {
    const holds = this.holds
    holds?.observe(event)
    if (
      !holds ||
      event.hookEventName !== 'PermissionRequest' ||
      req.headers[AGENT_TOOL_DECISION_HEADER] !== CLAUDE_PERMISSION_REQUEST_DECISION
    ) {
      return false
    }
    const opened: { drain?: () => void } = {}
    const admitted = holds.admit({
      event,
      promptId: event.providerPromptId,
      openChannel: () => {
        const channel = openClaudePermissionHookChannel(req, res)
        opened.drain = channel.drain
        return channel
      }
    })
    const drain = opened.drain
    if (admitted && drain) {
      this.drains.add(drain)
      res.once('close', () => this.drains.delete(drain))
    }
    return admitted
  }

  drain(): void {
    for (const drain of this.drains) {
      drain()
    }
    this.drains.clear()
  }
}
