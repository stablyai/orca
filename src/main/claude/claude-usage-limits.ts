import {
  agentSessionFailureFact,
  providerDiagnostic,
  type ProviderDiagnostic
} from '../../shared/agent-session/failures/agent-session-failure'
import {
  agentSessionFailureWords,
  type AgentSessionFailureRowWords
} from '../../shared/agent-session/failures/agent-session-failure-words'
import {
  usageLimitResetsAt,
  type AgentSessionUsageLimit,
  type AgentSessionUsageLimitWindow
} from '../../shared/agent-session/failures/agent-session-usage-limit'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeRecord, claudeText } from './structured/journal/claude-structured-item-translation'

const CLAUDE_LIMIT_WINDOWS: Record<string, AgentSessionUsageLimitWindow> = {
  five_hour: 'session',
  seven_day: 'weekly',
  seven_day_opus: 'weeklyModel',
  seven_day_sonnet: 'weeklyModel',
  seven_day_overage_included: 'weeklyModel',
  overage: 'credits'
}

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
  explicitProviderCode?: true
}

// Account observations outlive turns because unchanged rejection notifications are throttled.
export class ClaudeUsageLimits {
  private readonly rejected = new Map<string, number | null>()

  constructor(private readonly now: () => number = Date.now) {}

  /** An open command's own set records which limits rejected it while it ran. */
  observe(message: Record<string, unknown>, attempt?: Set<string>): void {
    if (message.type === 'rate_limit_event') {
      this.record(claudeRecord(message.rate_limit_info), attempt)
    }
  }

  assistant(message: Record<string, unknown>, turn?: ClaudeOpenTurn): ClaudeUsageLimitRow | null {
    if (message.type !== 'assistant') {
      return null
    }
    const typed = claudeText(message.api_error)
    // A login failure is an explicit cause, even though it carries no api_error.
    const cause =
      typed === 'usage_limit_reached'
        ? 'quota'
        : typed || message.error === 'authentication_failed'
          ? 'other'
          : 'untyped'
    if (cause === 'quota') {
      this.record(claudeRecord(claudeRecord(message.api_error_params)?.rate_limit_info))
    }
    const refused = message.error === 'rate_limit' || cause === 'quota'
    const root = message.parent_tool_use_id == null
    const decision = !typed && root ? (turn?.usageLimitEvidence?.cause ?? cause) : cause
    const row =
      decision !== 'other' && refused
        ? this.row(messageText(message), decision === 'quota', typed === 'usage_limit_reached')
        : null
    if (root && turn?.isOpen && (cause !== 'untyped' || (refused && decision === 'untyped'))) {
      turn.usageLimitEvidence = {
        cause: row ? 'quota' : cause,
        ...(typed === 'usage_limit_reached' ? { explicitProviderCode: true as const } : {})
      }
    }
    return row
  }

  result(
    message: Record<string, unknown>,
    failed: boolean,
    evidence: ClaudeUsageLimitEvidence | null,
    compactionFailure?: { detail?: ProviderDiagnostic; rejections: ReadonlySet<string> }
  ): ClaudeUsageLimitRow | null {
    if ((!failed && !compactionFailure) || evidence?.cause === 'other') {
      return null
    }
    const status = message.api_error_status
    const reason = claudeText(message.terminal_reason)
    const limited =
      evidence?.cause === 'quota' ||
      (evidence?.cause === 'untyped' &&
        (status == null || status === 429) &&
        (reason === null || LIMIT_TERMINAL_REASONS.includes(reason))) ||
      // Only a rejection received during this command can explain its failure; older ones are context.
      (compactionFailure !== undefined &&
        this.rejecting(compactionFailure.rejections) &&
        (status == null || status === 429) &&
        (reason === null || LIMIT_TERMINAL_REASONS.includes(reason) || reason === 'blocking_limit'))
    if (!limited) {
      return null
    }
    return this.row(
      compactionFailure?.detail?.text ?? claudeText(message.result) ?? '',
      evidence?.cause === 'quota',
      evidence?.explicitProviderCode === true
    )
  }

  private record(info: Record<string, unknown> | null, attempt?: Set<string>): void {
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
      attempt?.add(type)
    } else if (info.status === 'allowed' || info.status === 'allowed_warning' || overage) {
      this.rejected.delete(type)
      attempt?.delete(type)
    }
  }

  /** A limit this attempt saw rejecting must still be rejecting; an older one cannot stand in. */
  private rejecting(attempt: ReadonlySet<string>): boolean {
    this.expire()
    return [...attempt].some((type) => this.rejected.has(type))
  }

  private expire(): void {
    const now = this.now()
    for (const [type, resetsAt] of this.rejected) {
      if (resetsAt !== null && resetsAt <= now) {
        this.rejected.delete(type)
      }
    }
  }

  /** All rejecting limits must reset before requests can resume. */
  private limit(): AgentSessionUsageLimit | null {
    this.expire()
    if (this.rejected.size === 0) {
      return null
    }
    const windows = new Set([...this.rejected.keys()].map((type) => CLAUDE_LIMIT_WINDOWS[type]))
    const window = windows.size === 1 ? [...windows][0] : undefined
    const resets = [...this.rejected.values()].filter((reset): reset is number => reset !== null)
    const resetsAt = resets.length === this.rejected.size ? Math.max(...resets) : undefined
    return { ...(window ? { window } : {}), ...(resetsAt ? { resetsAt } : {}) }
  }

  private row(
    providerText: string,
    typed = false,
    explicitProviderCode = typed
  ): ClaudeUsageLimitRow | null {
    const limit = this.limit()
    if (!limit && !typed) {
      return null
    }
    return {
      kind: 'status',
      tone: 'warning',
      ...agentSessionFailureWords(
        agentSessionFailureFact('usageLimitReached', {
          ...((limit && (limit.window || limit.resetsAt)) || typed
            ? {
                usageLimit: {
                  ...limit,
                  ...(explicitProviderCode ? { providerCode: 'usage_limit_reached' as const } : {})
                }
              }
            : {}),
          detail: providerDiagnostic(providerText, 'person')
        }),
        { agentName: 'Claude', provider: 'claude', surface: 'row' }
      )
    }
  }
}
