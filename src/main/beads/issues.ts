import {
  normalizeBeadsIssue,
  type BeadsIssue,
  type BeadsIssuePreset,
  type BeadsIssueStatus,
  type BeadsWorkspaceStatus
} from '../../shared/beads-types'
import {
  getBdVersionInfo,
  isBdNotInitializedOutput,
  resolveBeadsActor,
  runBd,
  workspaceStatusFromVersion,
  type BdExecResult,
  type BeadsExecutionTarget
} from './client'

export const BEADS_ISSUE_LIST_MAX_LIMIT = 200

export type BeadsListIssuesResult = { issues: BeadsIssue[]; status: BeadsWorkspaceStatus }
export type BeadsGetIssueResult = { issue: BeadsIssue | null }
/** issue:null means bd is missing/unsupported/uninitialized — status says which; real update failures throw. */
export type BeadsUpdateIssueResult = { issue: BeadsIssue | null; status: BeadsWorkspaceStatus }

const BD_UPDATE_STATUSES: readonly BeadsIssueStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'deferred',
  'closed'
]

export function isBeadsIssueStatus(value: unknown): value is BeadsIssueStatus {
  return BD_UPDATE_STATUSES.includes(value as BeadsIssueStatus)
}

export function clampBeadsIssueLimit(value: unknown): number {
  const limit =
    typeof value === 'number' && Number.isFinite(value) ? value : BEADS_ISSUE_LIST_MAX_LIMIT
  return Math.min(Math.max(1, Math.floor(limit)), BEADS_ISSUE_LIST_MAX_LIMIT)
}

// Why: ids are always passed as argv (never a shell string); this only rejects
// strings bd would parse as flags plus obvious garbage.
export function isPlausibleBeadsIssueId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
}

function parseBdIssueArray(stdout: string): BeadsIssue[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  return parsed
    .map((raw) => normalizeBeadsIssue(raw))
    .filter((issue): issue is BeadsIssue => issue !== null)
}

function bdFailureOutput(result: BdExecResult): string {
  return `${result.stderr}\n${result.stdout}`
}

// bd 1.1.2 emits 'no issue found matching …' on stderr and '{"error":"no issues found matching …"}' on stdout.
function isBdIssueNotFoundOutput(output: string): boolean {
  return /no issues? found matching/i.test(output)
}

export type BeadsListStatusScope = 'open' | 'all' | 'ready'

export type BeadsListRequest = {
  /** Legacy route for clients predating beads-query-filter.v1. */
  preset?: BeadsIssuePreset
  /** 'all' includes closed issues; 'ready' is the bd-ready unblocked view. */
  statusScope?: BeadsListStatusScope
  /** '@me' resolves to the repo host's actor; anything else passes to `-a` verbatim. */
  assignee?: string
  limit?: number
}

type BeadsListPlan = { scope: BeadsListStatusScope; assignee: string | null }

/** Pure fetch routing: the query-filter params win entirely; else legacy preset semantics. */
export function resolveBeadsListPlan(request: BeadsListRequest): BeadsListPlan {
  if (request.statusScope !== undefined || request.assignee !== undefined) {
    return { scope: request.statusScope ?? 'open', assignee: request.assignee ?? null }
  }
  switch (request.preset ?? 'open') {
    case 'open':
      return { scope: 'open', assignee: null }
    case 'assigned':
      return { scope: 'open', assignee: '@me' }
    case 'ready':
      return { scope: 'ready', assignee: null }
  }
}

async function listArgsForPlan(
  target: BeadsExecutionTarget,
  plan: BeadsListPlan,
  limit: number
): Promise<string[] | null> {
  if (plan.scope === 'ready') {
    // bd ready has no -n or -a flags; ready results are filtered/truncated after parsing.
    return ['ready', '--json']
  }
  const args = ['list', '--json']
  if (plan.scope === 'all') {
    // Probed on bd 1.1.2: plain `bd list` omits only closed; --all restores them.
    args.push('--all')
  }
  args.push('-n', String(limit))
  if (plan.assignee) {
    const actor = plan.assignee === '@me' ? await resolveBeadsActor(target) : plan.assignee
    // Why: no resolvable actor means "assigned to me" has no answer; an
    // unfiltered list would silently show the wrong view.
    if (!actor) {
      return null
    }
    args.push('-a', actor)
  }
  return args
}

export async function listBeadsIssues(
  target: BeadsExecutionTarget,
  request: BeadsListRequest
): Promise<BeadsListIssuesResult> {
  const limit = clampBeadsIssueLimit(request.limit)
  const info = await getBdVersionInfo(target)
  if (!info.installed || !info.supported) {
    return { issues: [], status: workspaceStatusFromVersion(info, false) }
  }
  const args = await listArgsForPlan(target, resolveBeadsListPlan(request), limit)
  if (args === null) {
    const probe = await runBd(target, ['list', '--json', '-n', '1'])
    return { issues: [], status: workspaceStatusFromVersion(info, probe.exitCode === 0) }
  }
  const result = await runBd(target, args)
  if (result.exitCode === 0) {
    const issues = parseBdIssueArray(result.stdout)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
    return { issues, status: workspaceStatusFromVersion(info, true) }
  }
  if (result.spawnFailed) {
    return {
      issues: [],
      status: workspaceStatusFromVersion(
        { installed: false, version: null, supported: false },
        false
      )
    }
  }
  if (isBdNotInitializedOutput(bdFailureOutput(result))) {
    return { issues: [], status: workspaceStatusFromVersion(info, false) }
  }
  throw new Error(`bd ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`)
}

export async function getBeadsIssue(
  target: BeadsExecutionTarget,
  id: string
): Promise<BeadsGetIssueResult> {
  if (!isPlausibleBeadsIssueId(id)) {
    return { issue: null }
  }
  const info = await getBdVersionInfo(target)
  if (!info.installed || !info.supported) {
    return { issue: null }
  }
  const result = await runBd(target, ['show', id, '--json'])
  if (result.exitCode !== 0) {
    if (
      result.spawnFailed ||
      isBdNotInitializedOutput(bdFailureOutput(result)) ||
      // Why: a missing/stale id exits 1 (bd 1.1.2) — the contract promises issue:null, not an error.
      isBdIssueNotFoundOutput(bdFailureOutput(result))
    ) {
      return { issue: null }
    }
    throw new Error(`bd show failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  // `bd show --json` wraps the issue in an array.
  const issues = parseBdIssueArray(result.stdout)
  return { issue: issues[0] ?? null }
}

export async function updateBeadsIssueStatus(
  target: BeadsExecutionTarget,
  id: string,
  status: BeadsIssueStatus
): Promise<BeadsUpdateIssueResult> {
  if (!isPlausibleBeadsIssueId(id)) {
    throw new Error(`bd update rejected: implausible issue id ${JSON.stringify(id)}`)
  }
  const info = await getBdVersionInfo(target)
  if (!info.installed || !info.supported) {
    return { issue: null, status: workspaceStatusFromVersion(info, false) }
  }
  const result = await runBd(target, ['update', id, '--status', status, '--json'])
  if (result.exitCode !== 0) {
    if (result.spawnFailed) {
      return {
        issue: null,
        status: workspaceStatusFromVersion(
          { installed: false, version: null, supported: false },
          false
        )
      }
    }
    if (isBdNotInitializedOutput(bdFailureOutput(result))) {
      return { issue: null, status: workspaceStatusFromVersion(info, false) }
    }
    // Unknown id, invalid transition, etc. — a mutation must fail loudly, never no-op.
    throw new Error(`bd update failed: ${result.stderr.trim() || result.stdout.trim()}`)
  }
  // Why: bd 1.1.2's update payload omits dependency/comment counts; bd show has the full issue.
  const refreshed = await getBeadsIssue(target, id).catch(() => ({ issue: null }))
  const issue = refreshed.issue ?? parseBdIssueArray(result.stdout)[0] ?? null
  if (!issue) {
    throw new Error(`bd update succeeded but the refreshed issue ${id} could not be read back`)
  }
  return { issue, status: workspaceStatusFromVersion(info, true) }
}
