import type {
  MobileGitBranchChangeEntry,
  MobileGitBranchCompareResult,
  MobileGitBranchCompareSummary
} from '../source-control/mobile-branch-compare'
import type {
  MobileGitFileStatus,
  MobileGitStagingArea,
  MobileGitStatusEntry,
  MobileGitStatusResult,
  MobileGitUpstreamStatus
} from '../source-control/mobile-git-status'

export type MobileReviewGitDiffResult =
  | {
      kind: 'text'
      originalContent: string
      modifiedContent: string
    }
  | { kind: 'binary' }
  | { kind: 'too-large'; byteLength?: number }

export type MobileReviewWorktreeMetadata = {
  diffComments: unknown
  mobileDiffReview: unknown
}

export type MobileReviewTerminalTab = {
  id: string
  title: string
  terminal: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readFileStatus(value: unknown): MobileGitFileStatus | null {
  return value === 'modified' ||
    value === 'added' ||
    value === 'deleted' ||
    value === 'renamed' ||
    value === 'untracked' ||
    value === 'copied'
    ? value
    : null
}

function readStagingArea(value: unknown): MobileGitStagingArea | null {
  return value === 'staged' || value === 'unstaged' || value === 'untracked' ? value : null
}

function readConflictOperation(value: unknown): MobileGitStatusResult['conflictOperation'] {
  return value === 'merge' || value === 'rebase' || value === 'cherry-pick' || value === 'unknown'
    ? value
    : 'unknown'
}

function readUpstreamStatus(value: unknown): MobileGitUpstreamStatus | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const hasUpstream = readBoolean(value.hasUpstream)
  const ahead = readNumber(value.ahead)
  const behind = readNumber(value.behind)
  if (hasUpstream === undefined || ahead === undefined || behind === undefined) {
    return undefined
  }
  return {
    hasUpstream,
    upstreamName: readString(value.upstreamName),
    ahead,
    behind,
    hasConfiguredPushTarget: readBoolean(value.hasConfiguredPushTarget),
    behindCommitsArePatchEquivalent: readBoolean(value.behindCommitsArePatchEquivalent)
  }
}

function readStatusEntry(value: unknown): MobileGitStatusEntry | null {
  if (!isRecord(value)) {
    return null
  }
  const path = readString(value.path)
  const status = readFileStatus(value.status)
  const area = readStagingArea(value.area)
  if (!path || !status || !area) {
    return null
  }
  return {
    path,
    status,
    area,
    oldPath: readString(value.oldPath),
    conflictKind: undefined,
    conflictStatus:
      value.conflictStatus === 'unresolved' || value.conflictStatus === 'resolved_locally'
        ? value.conflictStatus
        : undefined,
    conflictStatusSource:
      value.conflictStatusSource === 'git' || value.conflictStatusSource === 'session'
        ? value.conflictStatusSource
        : undefined,
    added: readNumber(value.added),
    removed: readNumber(value.removed)
  }
}

export function readMobileGitStatusResult(value: unknown): MobileGitStatusResult | null {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    return null
  }
  return {
    entries: value.entries.flatMap((entry): MobileGitStatusEntry[] => {
      const parsed = readStatusEntry(entry)
      return parsed ? [parsed] : []
    }),
    conflictOperation: readConflictOperation(value.conflictOperation),
    branch: readString(value.branch),
    head: readString(value.head),
    upstreamStatus: readUpstreamStatus(value.upstreamStatus)
  }
}

function readBranchStatus(value: unknown): MobileGitBranchCompareSummary['status'] {
  return value === 'ready' ||
    value === 'invalid-base' ||
    value === 'unborn-head' ||
    value === 'no-merge-base' ||
    value === 'loading' ||
    value === 'error'
    ? value
    : 'error'
}

function readBranchEntry(value: unknown): MobileGitBranchChangeEntry | null {
  if (!isRecord(value)) {
    return null
  }
  const path = readString(value.path)
  const status = readFileStatus(value.status)
  if (!path || !status || status === 'untracked') {
    return null
  }
  return {
    path,
    status,
    oldPath: readString(value.oldPath),
    added: readNumber(value.added),
    removed: readNumber(value.removed)
  }
}

export function readMobileBranchCompareResult(value: unknown): MobileGitBranchCompareResult | null {
  if (!isRecord(value) || !isRecord(value.summary) || !Array.isArray(value.entries)) {
    return null
  }
  const baseRef = readString(value.summary.baseRef)
  const compareRef = readString(value.summary.compareRef)
  const changedFiles = readNumber(value.summary.changedFiles)
  if (!baseRef || !compareRef || changedFiles === undefined) {
    return null
  }
  return {
    summary: {
      baseRef,
      baseOid: readString(value.summary.baseOid) ?? null,
      compareRef,
      headOid: readString(value.summary.headOid) ?? null,
      mergeBase: readString(value.summary.mergeBase) ?? null,
      changedFiles,
      commitsAhead: readNumber(value.summary.commitsAhead),
      status: readBranchStatus(value.summary.status),
      errorMessage: readString(value.summary.errorMessage)
    },
    entries: value.entries.flatMap((entry): MobileGitBranchChangeEntry[] => {
      const parsed = readBranchEntry(entry)
      return parsed ? [parsed] : []
    })
  }
}

export function readMobileReviewWorktreeMetadata(value: unknown): MobileReviewWorktreeMetadata {
  if (!isRecord(value) || !isRecord(value.worktree)) {
    return { diffComments: undefined, mobileDiffReview: undefined }
  }
  return {
    diffComments: value.worktree.diffComments,
    mobileDiffReview: value.worktree.mobileDiffReview
  }
}

export function readMobileReviewGitDiffResult(value: unknown): MobileReviewGitDiffResult | null {
  if (!isRecord(value)) {
    return null
  }
  if (
    value.kind === 'text' &&
    typeof value.originalContent === 'string' &&
    typeof value.modifiedContent === 'string'
  ) {
    return {
      kind: 'text',
      originalContent: value.originalContent,
      modifiedContent: value.modifiedContent
    }
  }
  if (value.kind === 'binary') {
    return { kind: 'binary' }
  }
  if (value.kind === 'too-large') {
    return { kind: 'too-large', byteLength: readNumber(value.byteLength) }
  }
  return null
}

export function readMobileReviewTerminalTabs(value: unknown): MobileReviewTerminalTab[] {
  if (!isRecord(value) || !Array.isArray(value.tabs)) {
    return []
  }
  return value.tabs.flatMap((candidate): MobileReviewTerminalTab[] => {
    if (!isRecord(candidate) || candidate.type !== 'terminal') {
      return []
    }
    const id = readString(candidate.id)
    const terminal = readString(candidate.terminal)
    if (!id || !terminal) {
      return []
    }
    return [
      {
        id,
        terminal,
        title: readString(candidate.title) ?? 'Terminal'
      }
    ]
  })
}

export function readMobileReviewCreatedTerminal(value: unknown): MobileReviewTerminalTab | null {
  if (!isRecord(value) || !isRecord(value.tab)) {
    return null
  }
  return readMobileReviewTerminalTabs({ tabs: [value.tab] })[0] ?? null
}

export function readMobileReviewTerminalSendAccepted(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.send)) {
    return true
  }
  return value.send.accepted !== false
}
