import type { GitHubWorkItem, LinearIssue } from '../../../src/shared/types'
import type { NewWorkspaceSourceRow } from './new-workspace-source-types'

export class IncompatibleWorkspaceSourceResponseError extends Error {}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function messageFrom(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null
  }
  const candidate = record(value)
  return typeof candidate?.message === 'string' ? candidate.message.trim() || null : null
}

function githubItem(value: unknown, repoId: string): GitHubWorkItem | null {
  const item = record(value)
  if (
    !item ||
    (item.type !== 'issue' && item.type !== 'pr') ||
    typeof item.number !== 'number' ||
    !Number.isInteger(item.number) ||
    item.number <= 0 ||
    typeof item.id !== 'string' ||
    typeof item.title !== 'string' ||
    typeof item.url !== 'string'
  ) {
    return null
  }
  // Why: rows are snapshots for the selected repo; never carry a repo id from
  // an old or malformed host response into later repo-scoped RPCs.
  return { ...item, repoId } as GitHubWorkItem
}

function linearIssue(value: unknown): LinearIssue | null {
  const issue = record(value)
  if (
    !issue ||
    typeof issue.id !== 'string' ||
    typeof issue.identifier !== 'string' ||
    typeof issue.title !== 'string' ||
    typeof issue.url !== 'string'
  ) {
    return null
  }
  return issue as LinearIssue
}

export function normalizeGitHubSourceResponse(
  value: unknown,
  repoId: string
): { rows: NewWorkspaceSourceRow[]; warnings: string[] } {
  const envelope = record(value)
  if (!envelope || !Array.isArray(envelope.items) || !record(envelope.sources)) {
    throw new IncompatibleWorkspaceSourceResponseError(
      'The selected host returned incompatible GitHub results.'
    )
  }
  const rows = envelope.items.flatMap((raw) => {
    const item = githubItem(raw, repoId)
    return item
      ? [{ kind: 'github' as const, key: `github-${repoId}-${item.type}-${item.number}`, item }]
      : []
  })
  const issuesError = record(envelope.errors)?.issues
  const warning = messageFrom(issuesError)
  return { rows, warnings: warning ? [warning] : [] }
}

export function normalizeLinearSourceResponse(value: unknown): {
  rows: NewWorkspaceSourceRow[]
  warnings: string[]
} {
  const envelope = Array.isArray(value) ? null : record(value)
  const items = Array.isArray(value) ? value : envelope?.items
  if (!Array.isArray(items)) {
    throw new IncompatibleWorkspaceSourceResponseError(
      'The selected host returned incompatible Linear results.'
    )
  }
  const rows = items.flatMap((raw) => {
    const issue = linearIssue(raw)
    return issue
      ? [
          {
            kind: 'linear' as const,
            key: `linear-${issue.workspaceId ?? 'default'}-${issue.id}`,
            issue
          }
        ]
      : []
  })
  const errors = Array.isArray(envelope?.errors) ? envelope.errors : []
  return { rows, warnings: errors.map(messageFrom).filter((item): item is string => Boolean(item)) }
}

export function normalizeRefSourceResponse(value: unknown): NewWorkspaceSourceRow[] {
  const envelope = record(value)
  const hasDetails = Array.isArray(envelope?.refDetails)
  const hasLegacy = Array.isArray(envelope?.refs)
  if (!envelope || (!hasDetails && !hasLegacy)) {
    throw new IncompatibleWorkspaceSourceResponseError(
      'The selected host returned incompatible branch results.'
    )
  }
  const verified = hasDetails
    ? (envelope.refDetails as unknown[]).flatMap((raw) => {
        const row = record(raw)
        return typeof row?.refName === 'string' && typeof row.localBranchName === 'string'
          ? [
              {
                kind: 'branch' as const,
                key: `branch-verified-${row.refName}`,
                refName: row.refName,
                localBranchName: row.localBranchName,
                verified: true
              }
            ]
          : []
      })
    : []
  const verifiedNames = new Set(verified.map((row) => row.refName))
  const legacy = hasLegacy
    ? (envelope.refs as unknown[]).flatMap((raw) =>
        typeof raw === 'string' && raw && !verifiedNames.has(raw)
          ? [
              {
                kind: 'branch' as const,
                key: `branch-legacy-${raw}`,
                refName: raw,
                localBranchName: raw,
                verified: false
              }
            ]
          : []
      )
    : []
  return [...verified, ...legacy]
}
