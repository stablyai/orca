import type { CodexManagedAccountSummary } from '../shared/types'
import type { OrchestrationMessageSummary } from '../shared/orchestration-check-output'
import type { OrchestrationWorkerReadResult } from '../shared/orchestration-worker-output'
import type { GitStatusResult } from '../shared/git-status-types'

export type CodexAccountSelector = Pick<
  CodexManagedAccountSummary,
  'id' | 'email' | 'workspaceLabel'
>

export function parseAccountOrder(
  raw: string | undefined,
  accounts: CodexAccountSelector[]
): string[] {
  if (raw) {
    const requested = raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    if (requested.length === 0) {
      throw new Error('--accounts must contain at least one account selector')
    }
    return requested
  }

  const numbered = accounts
    .flatMap((account) => {
      const match = account.workspaceLabel?.match(/(?:^|\s)#(\d+)(?:\s|$|｜|\|)/)
      return match ? [{ selector: `#${match[1]}`, order: Number(match[1]) }] : []
    })
    .sort((left, right) => right.order - left.order)
    .map((entry) => entry.selector)

  // Why: two accounts sharing one workspace #N would make every later resolve of that selector
  // ambiguous mid-run; failing during setup keeps the failover from starting doomed.
  const duplicated = numbered.filter((selector, index) => numbered.indexOf(selector) !== index)
  if (duplicated.length > 0) {
    throw new Error(
      `Codex workspace number(s) ${[...new Set(duplicated)].join(', ')} match more than one managed account. Pass --accounts with exact IDs.`
    )
  }
  if (numbered.length === 0) {
    throw new Error(
      'No numbered Codex accounts were found. Pass --accounts with exact IDs, emails, labels, or #numbers.'
    )
  }
  return numbered
}

export function resolveCodexAccount(
  accounts: CodexAccountSelector[],
  selector: string
): CodexAccountSelector {
  const byId = accounts.filter((account) => account.id === selector)
  if (byId.length === 1) {
    return byId[0]!
  }

  const byLabel = accounts.filter((account) => account.workspaceLabel === selector)
  if (byLabel.length === 1) {
    return byLabel[0]!
  }

  const byEmail = accounts.filter((account) => account.email === selector)
  if (byEmail.length === 1) {
    return byEmail[0]!
  }

  const number = selector.match(/^#(\d+)$/)?.[1]
  const byNumber = number
    ? accounts.filter((account) =>
        account.workspaceLabel?.match(new RegExp(`(?:^|\\s)#${number}(?:\\s|$|｜|\\|)`))
      )
    : []
  if (byNumber.length === 1) {
    return byNumber[0]!
  }

  const matches = [...byId, ...byLabel, ...byEmail, ...byNumber]
  if (matches.length > 1) {
    throw new Error(`Codex account selector "${selector}" is ambiguous; use the exact account ID.`)
  }
  throw new Error(`Codex account selector "${selector}" did not match a managed account.`)
}

// Why: real provider strings carry suffixes ("You've hit your usage limit. Visit https://… or try
// again at <date>.") and may use either apostrophe form, so the rules anchor the line start only.
// Verified against a captured 2026-08 Codex provider sample; keep new patterns sample-backed.
const QUOTA_LINES = [
  /^usage limit reached\b/i,
  /^you(?:['’]ve| have) hit your usage limit\b/i,
  /^you(?:['’]ve| have) (?:run out of|used all) (?:your )?(?:codex )?(?:credits|usage)\b/i,
  /^your (?:codex )?(?:usage|credit) limit has been reached\b/i
]

export function isCodexQuotaExhaustedText(text: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => QUOTA_LINES.some((pattern) => pattern.test(line)))
}

export function isCodexQuotaExhaustedRead(result: OrchestrationWorkerReadResult): boolean {
  if (result.source !== 'transcript') {
    // Why: terminal tails have no author identity. A prompt or echoed command could contain the
    // same words, so unstructured terminal text is never sufficient evidence to switch accounts.
    return false
  }
  // Why: only system messages qualify — the runtime authors them from the provider's structured
  // error fields (e.g. Codex task_complete.error). Assistant text is model output and can echo
  // task material, so it is never provider evidence and must not trigger an account switch.
  return result.transcript.messages.some(
    (message) =>
      message.role === 'system' &&
      message.blocks.some((block) => block.type === 'text' && isCodexQuotaExhaustedText(block.text))
  )
}

export function lifecycleMessageForDispatch(
  messages: OrchestrationMessageSummary[],
  dispatchId: string
): OrchestrationMessageSummary | undefined {
  return messages.find((message) => {
    if (!['worker_done', 'question', 'escalation'].includes(message.type ?? '')) {
      return false
    }
    if (!message.payload) {
      return false
    }
    try {
      const payload = JSON.parse(message.payload) as {
        dispatchId?: unknown
        _orcaLifecycleRejection?: unknown
      }
      // Why: reconcile persists `_orcaLifecycleRejection` on duplicate/stale lifecycle messages;
      // acting on one would report a settlement the runtime already refused.
      if (payload._orcaLifecycleRejection) {
        return false
      }
      return payload.dispatchId === dispatchId
    } catch {
      return false
    }
  })
}

export function buildAcceptancePayload(input: {
  taskId: string
  dispatchId: string
  evidence: string
  accountId?: string
  accountLabel?: string | null
  worktreeCloseable: boolean
  worktreeReason: string
  worktreeSha?: string | null
}): string {
  return JSON.stringify({
    taskId: input.taskId,
    dispatchId: input.dispatchId,
    outcome: 'accepted',
    evidence: input.evidence,
    accountId: input.accountId ?? null,
    accountLabel: input.accountLabel ?? null,
    worktree: {
      closeable: input.worktreeCloseable,
      reason: input.worktreeReason,
      // Why: the receipt must answer "which SHA was accepted" without the worktree surviving.
      sha: input.worktreeSha ?? null,
      removed: false
    }
  })
}

export function evaluateWorktreeClosure(status: GitStatusResult): {
  closeable: boolean
  reason: string
} {
  if (status.didHitLimit) {
    return { closeable: false, reason: 'git status was truncated' }
  }
  // Why: a rebase/merge/cherry-pick can pause on a momentarily clean tree; the in-progress
  // operation still owns the worktree. `unknown` is also the normal no-operation value, so only
  // the three explicit operations block closure.
  if (['merge', 'rebase', 'cherry-pick'].includes(status.conflictOperation)) {
    return {
      closeable: false,
      reason: `a ${status.conflictOperation} operation is still in progress`
    }
  }
  if (status.entries.length > 0) {
    return {
      closeable: false,
      reason: `worktree has ${status.entries.length} uncommitted change(s)`
    }
  }
  // Why: the authority contract marks a worktree closeable only when its commits are persisted
  // (pushed branch or PR). A clean tree with unpushed commits still holds the only copy of the
  // work, so the boolean must stay false — a reason-string warning is not machine-readable.
  const upstream = status.upstreamStatus
  if (!upstream?.hasUpstream) {
    return {
      closeable: false,
      reason:
        'branch has no upstream; commits are not persisted remotely, so the worktree must be retained'
    }
  }
  if (upstream.ahead > 0) {
    return {
      closeable: false,
      reason: `branch is ahead of its upstream by ${upstream.ahead} unpushed commit(s)`
    }
  }
  // Why: the acceptance receipt must record which HEAD SHA was accepted; a status without a HEAD
  // (mixed-version host, incomplete result) cannot prove what would be closed, so it is retained.
  if (!status.head) {
    return {
      closeable: false,
      reason: 'git status did not report a HEAD SHA, so the accepted state cannot be recorded'
    }
  }
  return {
    closeable: true,
    reason:
      'git worktree is clean and its branch is fully pushed; the coordinator may archive or remove it explicitly'
  }
}

// Why: pure so the deadline-capping arithmetic is unit-testable without driving the poll loop.
export function boundedPollDelayMs(pollMs: number, deadline: number, now: number): number {
  return Math.max(0, Math.min(pollMs, deadline - now))
}

// Why: recovery commands are pasted into a real shell. Double quotes let POSIX shells expand $,
// backticks, and backslashes, silently changing the replayed payload; single-quote escaping is the
// only quoting an interactive shell round-trips byte-identically.
export function posixShellQuote(value: string): string {
  // Why: `#` must NOT be in the safe set — an unquoted leading # starts a shell comment and
  // silently truncates everything after it (e.g. `--accounts #3,#2`).
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value
  }
  return `'${value.replaceAll("'", `'\\''`)}'`
}
