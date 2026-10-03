import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import {
  SSH_USAGE_SCAN_CLAUDE_PAGE_TIMEOUT_MS,
  SSH_USAGE_SCAN_PAGES_MAX,
  isUsageRelayRecord,
  type SshClaudeUsageScanParams,
  type SshClaudeUsageScanResult
} from './ssh-usage-relay-contract'
import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsageSession,
  ClaudeUsageSshHostSnapshot
} from './types'

export type ClaudeUsageSshTransport = {
  listConnectedTargetIds(): string[]
  /** Resolves null when the host's relay cannot scan usage. */
  requestScan(
    targetId: string,
    params: SshClaudeUsageScanParams,
    options: { timeoutMs?: number }
  ): Promise<unknown>
}

function isScanPage(value: unknown): value is SshClaudeUsageScanResult {
  return (
    isUsageRelayRecord(value) &&
    typeof value.scanId === 'string' &&
    Number.isSafeInteger(value.pageIndex) &&
    Number.isSafeInteger(value.pageCount) &&
    Array.isArray(value.sessions) &&
    Array.isArray(value.dailyAggregates)
  )
}

// Why: every key needs the host, `worktree:` included. A worktree id is
// `<repoId>::<path>`, and one project's repo id is shared by all its execution
// hosts, so the same checkout path on two hosts (or on this Mac) yields one id.
function hostScopedKey(targetId: string, key: string): string {
  return `ssh:${targetId}|${key}`
}

function scopeSession(targetId: string, session: ClaudeUsageSession): ClaudeUsageSession {
  return {
    ...session,
    locationBreakdown: session.locationBreakdown.map((location) => ({
      ...location,
      locationKey: hostScopedKey(targetId, location.locationKey)
    }))
  }
}

function scopeDaily(
  targetId: string,
  aggregate: ClaudeUsageDailyAggregate
): ClaudeUsageDailyAggregate {
  return { ...aggregate, projectKey: hostScopedKey(targetId, aggregate.projectKey) }
}

async function fetchHostScan(
  transport: ClaudeUsageSshTransport,
  targetId: string,
  worktrees: UsageScanWorktreeRef[]
): Promise<Omit<ClaudeUsageSshHostSnapshot, 'scannedAt'> | null> {
  const first = await transport.requestScan(targetId, { worktrees }, {})
  if (first === null) {
    return null
  }
  if (!isScanPage(first)) {
    throw new Error('Malformed Claude usage scan response')
  }
  const sessions = [...first.sessions]
  const dailyAggregates = [...first.dailyAggregates]
  const pageCount = Math.min(first.pageCount, SSH_USAGE_SCAN_PAGES_MAX)
  for (let index = 1; index < pageCount; index += 1) {
    const page = await transport.requestScan(
      targetId,
      { worktrees, page: { scanId: first.scanId, index } },
      { timeoutMs: SSH_USAGE_SCAN_CLAUDE_PAGE_TIMEOUT_MS }
    )
    if (!isScanPage(page) || page.scanId !== first.scanId) {
      throw new Error('Malformed Claude usage scan page')
    }
    sessions.push(...page.sessions)
    dailyAggregates.push(...page.dailyAggregates)
  }
  return {
    sessions: sessions.map((session) => scopeSession(targetId, session)),
    dailyAggregates: dailyAggregates.map((aggregate) => scopeDaily(targetId, aggregate))
  }
}

/**
 * Refresh per-host snapshots for connected SSH targets. A host that is offline,
 * too old, or failing keeps its last snapshot so its history does not vanish.
 */
export async function scanClaudeUsageOnSshHosts(args: {
  transport: ClaudeUsageSshTransport
  worktreesByTarget: Map<string, UsageScanWorktreeRef[]>
  previous: Record<string, ClaudeUsageSshHostSnapshot>
  now?: () => number
  onHostError?: (targetId: string, error: unknown) => void
}): Promise<Record<string, ClaudeUsageSshHostSnapshot>> {
  const now = args.now ?? Date.now
  const connected = args.transport.listConnectedTargetIds()
  const next: Record<string, ClaudeUsageSshHostSnapshot> = {}
  // Why: a removed SSH target has neither repos nor a session; drop its data.
  for (const [targetId, snapshot] of Object.entries(args.previous)) {
    if (args.worktreesByTarget.has(targetId) || connected.includes(targetId)) {
      next[targetId] = snapshot
    }
  }
  await Promise.all(
    connected.map(async (targetId) => {
      try {
        const scanned = await fetchHostScan(
          args.transport,
          targetId,
          args.worktreesByTarget.get(targetId) ?? []
        )
        if (scanned) {
          next[targetId] = { ...scanned, scannedAt: now() }
        }
      } catch (error) {
        args.onHostError?.(targetId, error)
      }
    })
  )
  return next
}

export function mergeClaudeUsageWithSshHosts(
  local: { sessions: ClaudeUsageSession[]; dailyAggregates: ClaudeUsageDailyAggregate[] },
  hosts: Record<string, ClaudeUsageSshHostSnapshot>
): { sessions: ClaudeUsageSession[]; dailyAggregates: ClaudeUsageDailyAggregate[] } {
  const snapshots = Object.values(hosts)
  if (snapshots.length === 0) {
    return local
  }
  return {
    // Why: Recent Sessions takes the head of this list, so it must stay newest-first
    // like the local scan's `finalizeClaudeSessions` output, not local-then-remote.
    sessions: [...local.sessions, ...snapshots.flatMap((snapshot) => snapshot.sessions)].sort(
      (left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp)
    ),
    dailyAggregates: [
      ...local.dailyAggregates,
      ...snapshots.flatMap((snapshot) => snapshot.dailyAggregates)
    ].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }
}
