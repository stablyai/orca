import { agentSessionFailureFact, providerDiagnostic } from '../../shared/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureRowWords
} from '../../shared/agent-session-failure-words'
import {
  usageLimitResetsAt,
  type AgentSessionUsageLimit,
  type AgentSessionUsageLimitWindow
} from '../../shared/agent-session-usage-limit'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeRecord, claudeText } from './claude-structured-item-translation'

const CLAUDE_LIMIT_WINDOWS: Record<string, AgentSessionUsageLimitWindow> = {
  five_hour: 'session',
  seven_day: 'weekly',
  seven_day_opus: 'weeklyModel',
  seven_day_sonnet: 'weeklyModel',
  seven_day_overage_included: 'weeklyModel',
  overage: 'credits'
}

/** The ends a result reports when a limit refused its request; any other is a different failure. */
const LIMIT_TERMINAL_REASONS = ['api_error']

export type ClaudeUsageLimitRow = AgentSessionFailureRowWords & {
  kind: 'status'
  tone: 'warning'
}

function messageText(message: Record<string, unknown>): string {
  const content = claudeRecord(message.message)?.content
  return Array.isArray(content)
    ? content
        .flatMap((part) => {
          const value = claudeRecord(part)
          return value?.type === 'text' && typeof value.text === 'string' ? [value.text] : []
        })
        .join('\n')
    : ''
}

export type ClaudeUsageLimitEvidence = {
  cause: 'quota' | 'other' | 'untyped'
}

// Account observations outlive turns because unchanged rejection notifications are throttled.
export class ClaudeUsageLimits {
  private readonly rejected = new Map<string, number | null>()

  constructor(private readonly now: () => number = Date.now) {}

  observe(message: Record<string, unknown>): void {
    if (message.type === 'rate_limit_event') {
      this.record(claudeRecord(message.rate_limit_info))
    }
  }

  assistant(message: Record<string, unknown>, turn?: ClaudeOpenTurn): ClaudeUsageLimitRow | null {
    if (message.type !== 'assistant') {
      return null
    }
    const typed = claudeText(message.api_error)
    const cause = typed === 'usage_limit_reached' ? 'quota' : typed ? 'other' : 'untyped'
    if (cause === 'quota') {
      this.record(claudeRecord(claudeRecord(message.api_error_params)?.rate_limit_info))
    }
    const refused = message.error === 'rate_limit' || cause === 'quota'
    const root = message.parent_tool_use_id == null
    const decision = !typed && root ? (turn?.usageLimitEvidence?.cause ?? cause) : cause
    const row =
      decision !== 'other' && refused ? this.row(messageText(message), decision === 'quota') : null
    if (root && turn?.isOpen && (typed || (refused && decision === 'untyped'))) {
      turn.usageLimitEvidence = { cause: row ? 'quota' : cause }
    }
    return row
  }

  result(
    message: Record<string, unknown>,
    failed: boolean,
    evidence: ClaudeUsageLimitEvidence | null
  ): ClaudeUsageLimitRow | null {
    if (!failed || evidence?.cause === 'other') {
      return null
    }
    const status = message.api_error_status
    const reason = claudeText(message.terminal_reason)
    const limited =
      evidence?.cause === 'quota' ||
      (evidence?.cause === 'untyped' &&
        (status == null || status === 429) &&
        (reason === null || LIMIT_TERMINAL_REASONS.includes(reason)))
    if (!limited) {
      return null
    }
    return this.row(claudeText(message.result) ?? '', evidence?.cause === 'quota')
  }

  private record(info: Record<string, unknown> | null): void {
    if (!info) {
      return
    }
    const type = claudeText(info.rateLimitType) ?? 'unknown'
    const overage =
      info.overageStatus === 'allowed' ||
      info.overageStatus === 'allowed_warning' ||
      info.isUsingOverage === true ||
      info.overageInUse === true
    if (info.status === 'rejected' && !overage) {
      const seconds = info.resetsAt
      const resetsAt =
        typeof seconds === 'number' ? usageLimitResetsAt(seconds * 1000, this.now()) : undefined
      this.rejected.set(type, resetsAt ?? null)
    } else if (info.status === 'allowed' || info.status === 'allowed_warning' || overage) {
      this.rejected.delete(type)
    }
  }

  /** Every refusing limit must reset before a request can run, so the latest reset is the one. */
  private limit(): AgentSessionUsageLimit | null {
    const now = this.now()
    for (const [type, resetsAt] of this.rejected) {
      if (resetsAt !== null && resetsAt <= now) {
        this.rejected.delete(type)
      }
    }
    if (this.rejected.size === 0) {
      return null
    }
    const windows = new Set([...this.rejected.keys()].map((type) => CLAUDE_LIMIT_WINDOWS[type]))
    const window = windows.size === 1 ? [...windows][0] : undefined
    const resets = [...this.rejected.values()].filter((reset): reset is number => reset !== null)
    const resetsAt = resets.length === this.rejected.size ? Math.max(...resets) : undefined
    return { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
  }

  private row(providerText: string, typed = false): ClaudeUsageLimitRow | null {
    const limit = this.limit()
    if (!limit && !typed) {
      return null
    }
    return {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', {
          ...(limit && (limit.window || limit.resetsAt) ? { usageLimit: limit } : {}),
          detail: providerDiagnostic(providerText, 'person')
        }),
        { agentName: 'Claude', provider: 'claude', surface: 'row' }
      )
    }
  }
}
