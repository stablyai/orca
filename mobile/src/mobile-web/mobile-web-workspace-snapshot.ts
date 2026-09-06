import {
  MOBILE_WEB_WORKSPACE_SNAPSHOT_MAX_BYTES,
  MOBILE_WEB_WORKSPACE_SNAPSHOT_LIMIT,
  MobileWebWorkspaceSnapshotResultSchema,
  type MobileWebWorkspaceAgent,
  type MobileWebWorkspaceSnapshotResult,
  type MobileWebWorkspaceSummary
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const MOBILE_WEB_WORKSPACE_AGENT_LIMIT = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown, maximum: number, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : fallback
}

function boundedBranch(value: unknown): string {
  const branch = boundedText(value, 240, 'No branch')
  return branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
}

function boundedOptionalText(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maximum) : null
}

function boundedInteger(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : fallback
}

function boundedPositiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function folderName(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  const trimmed = value.replace(/[\\/]+$/, '')
  const name = trimmed.split(/[\\/]/).at(-1) ?? ''
  return /^[A-Za-z]:$/.test(name) ? '' : name.slice(0, 160)
}

function displayRepo(value: unknown): string {
  const repo = boundedText(value, 240, 'Repository')
  if (repo.startsWith('/') || /^[A-Za-z]:[\\/]/.test(repo) || repo.startsWith('\\\\')) {
    return folderName(repo) || 'Repository'
  }
  return repo
}

function workspaceStatus(value: unknown): MobileWebWorkspaceSummary['status'] {
  return value === 'working' ||
    value === 'active' ||
    value === 'permission' ||
    value === 'done' ||
    value === 'inactive'
    ? value
    : 'inactive'
}

function agentState(value: unknown): MobileWebWorkspaceAgent['state'] {
  return value === 'working' || value === 'blocked' || value === 'waiting' || value === 'done'
    ? value
    : 'done'
}

function sanitizeAgents(value: unknown): MobileWebWorkspaceAgent[] {
  if (!Array.isArray(value)) {
    return []
  }
  const sources = value
    .filter(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) && typeof candidate.paneKey === 'string' && candidate.paneKey.length > 0
    )
    .slice(0, MOBILE_WEB_WORKSPACE_AGENT_LIMIT)
  const idByPaneKey = new Map(sources.map((source, index) => [source.paneKey, `agent-${index}`]))
  return sources.map((source, index) => ({
    id: `agent-${index}`,
    parentId:
      typeof source.parentPaneKey === 'string'
        ? (idByPaneKey.get(source.parentPaneKey) ?? null)
        : null,
    state: agentState(source.state),
    agentType: boundedOptionalText(source.agentType, 80),
    prompt: boundedText(source.prompt, 512, ''),
    taskTitle: boundedOptionalText(source.taskTitle, 240),
    displayName: boundedOptionalText(source.displayName, 240),
    lastAssistantMessage: boundedOptionalText(source.lastAssistantMessage, 512),
    interrupted: source.interrupted === true,
    stateStartedAt: boundedInteger(source.stateStartedAt, 0) ?? 0,
    updatedAt: boundedInteger(source.updatedAt, 0) ?? 0
  }))
}

function validParentWorkspaceId(
  value: Record<string, unknown>,
  byHostId: ReadonlyMap<string, Record<string, unknown>>
): string | null {
  if (typeof value.parentWorktreeId !== 'string' || value.parentWorktreeId === value.worktreeId) {
    return null
  }
  const parent = byHostId.get(value.parentWorktreeId)
  if (!parent) {
    return null
  }
  const expectedParentInstance = value.parentWorktreeInstanceId
  if (typeof expectedParentInstance !== 'string') {
    return value.parentWorktreeId
  }
  const parentInstance =
    typeof parent.lineageWorktreeInstanceId === 'string'
      ? parent.lineageWorktreeInstanceId
      : parent.worktreeInstanceId
  return parentInstance === expectedParentInstance ? value.parentWorktreeId : null
}

function hasLineageCycle(
  workspaceId: string,
  parentByWorkspaceId: ReadonlyMap<string, string | null>
): boolean {
  const seen = new Set([workspaceId])
  let parentId = parentByWorkspaceId.get(workspaceId) ?? null
  while (parentId) {
    if (seen.has(parentId)) {
      return true
    }
    seen.add(parentId)
    parentId = parentByWorkspaceId.get(parentId) ?? null
  }
  return false
}

export function mobileWebWorkspaceSnapshot(
  result: unknown,
  requestedLimit: number,
  authority: MobileWebWorkspaceAuthority
): MobileWebWorkspaceSnapshotResult {
  return mobileWebWorkspaceSnapshotPage(result, requestedLimit, authority, 0).snapshot
}

export function mobileWebWorkspaceSnapshotPage(
  result: unknown,
  requestedLimit: number,
  authority: MobileWebWorkspaceAuthority,
  requestedOffset: number
): { snapshot: MobileWebWorkspaceSnapshotResult; nextOffset: number | null } {
  if (!isRecord(result) || !Array.isArray(result.worktrees)) {
    throw new Error('mobile_web_workspace_snapshot_invalid')
  }
  const limit = Math.min(requestedLimit, MOBILE_WEB_WORKSPACE_SNAPSHOT_LIMIT)
  const rawWorkspaces = result.worktrees.filter(
    (value): value is Record<string, unknown> & { worktreeId: string } =>
      isRecord(value) &&
      typeof value.worktreeId === 'string' &&
      value.worktreeId.length > 0 &&
      value.worktreeId.length <= 512
  )
  const invalidRows = rawWorkspaces.length !== result.worktrees.length
  const hostRepoIdByWorkspaceId = new Map(
    rawWorkspaces.map((value) => [
      value.worktreeId,
      boundedText(value.repoId, 512, `workspace-repo:${value.worktreeId}`)
    ])
  )
  authority.synchronize(
    rawWorkspaces.map((value) => ({
      workspaceId: value.worktreeId,
      repoId: hostRepoIdByWorkspaceId.get(value.worktreeId)!
    }))
  )
  const byHostId = new Map(rawWorkspaces.map((value) => [value.worktreeId, value]))
  const parentByWorkspaceId = new Map(
    rawWorkspaces.map((value) => [value.worktreeId, validParentWorkspaceId(value, byHostId)])
  )
  const workspaces: MobileWebWorkspaceSummary[] = []
  let byteTruncated = false
  let nextOffset = Math.min(Math.max(0, requestedOffset), rawWorkspaces.length)
  for (let index = nextOffset; index < rawWorkspaces.length; index += 1) {
    const value = rawWorkspaces[index]!
    if (workspaces.length >= limit) {
      break
    }
    const id = authority.pageWorkspaceId(value.worktreeId)
    const liveTerminalCount =
      typeof value.liveTerminalCount === 'number' &&
      Number.isInteger(value.liveTerminalCount) &&
      value.liveTerminalCount >= 0
        ? Math.min(value.liveTerminalCount, 10_000)
        : 0
    const parentWorkspaceId = hasLineageCycle(value.worktreeId, parentByWorkspaceId)
      ? null
      : parentByWorkspaceId.get(value.worktreeId)
    const workspace: MobileWebWorkspaceSummary = {
      id,
      repoId: authority.pageRepoId(hostRepoIdByWorkspaceId.get(value.worktreeId)!),
      workspaceKind: value.workspaceKind === 'folder-workspace' ? 'folder-workspace' : 'git',
      name: boundedText(value.displayName, 160, 'Workspace'),
      repo: displayRepo(value.repo),
      branch: boundedBranch(value.branch),
      folderName: folderName(value.path),
      workspaceStatus: boundedText(value.workspaceStatus, 80, ''),
      sortOrder: finiteNumber(value.sortOrder, 0),
      manualOrder:
        typeof value.manualOrder === 'number' && Number.isFinite(value.manualOrder)
          ? value.manualOrder
          : null,
      lastActivityAt: boundedInteger(value.lastActivityAt, null),
      createdAt: boundedInteger(value.createdAt, null),
      isArchived: value.isArchived === true,
      isMainWorktree: value.isMainWorktree === true,
      hasHostSidebarActivity: value.hasHostSidebarActivity === true,
      parentWorkspaceId: parentWorkspaceId ? authority.pageWorkspaceId(parentWorkspaceId) : null,
      liveTerminalCount,
      hasAttachedPty: value.hasAttachedPty === true,
      unread: value.unread === true,
      lastOutputAt: boundedInteger(value.lastOutputAt, null),
      isPinned: value.isPinned === true,
      isActive: value.isActive === true,
      linkedPR:
        isRecord(value.linkedPR) && boundedPositiveInteger(value.linkedPR.number) !== null
          ? {
              number: boundedPositiveInteger(value.linkedPR.number) ?? 1,
              state: boundedText(value.linkedPR.state, 80, 'unknown')
            }
          : null,
      linkedIssue: boundedPositiveInteger(value.linkedIssue),
      linkedLinearIssue: boundedOptionalText(value.linkedLinearIssue, 160),
      linkedGitLabMR: boundedPositiveInteger(value.linkedGitLabMR),
      linkedGitLabIssue: boundedPositiveInteger(value.linkedGitLabIssue),
      comment: boundedText(value.comment, 512, ''),
      status: workspaceStatus(value.status),
      agents: sanitizeAgents(value.agents)
    }
    const candidate = { workspaces: [...workspaces, workspace], truncated: true }
    if (encodedByteLength(candidate) > MOBILE_WEB_WORKSPACE_SNAPSHOT_MAX_BYTES) {
      byteTruncated = true
      break
    }
    workspaces.push(workspace)
    nextOffset = index + 1
  }
  const snapshot = {
    workspaces,
    truncated:
      byteTruncated || invalidRows || nextOffset < rawWorkspaces.length || result.truncated === true
  }
  return {
    snapshot: MobileWebWorkspaceSnapshotResultSchema.parse(snapshot),
    nextOffset: nextOffset < rawWorkspaces.length ? nextOffset : null
  }
}

function encodedByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
