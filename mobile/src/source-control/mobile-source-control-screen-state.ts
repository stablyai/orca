import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  Check,
  CloudUpload,
  GitBranch,
  GitPullRequestArrow,
  History,
  RefreshCw,
  type LucideIcon
} from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { MobileSourceControlActionIcon } from './mobile-source-control-actions'
import type { MobileDiffLine } from '../session/mobile-diff-lines'
import type { MobileHighlightedDiffLine } from '../session/mobile-file-syntax'
import type {
  MobileGitBranchChangeEntry,
  MobileGitBranchCompareResult,
  MobileGitBranchCompareSummary
} from './mobile-branch-compare'
import type {
  MobileGitFileStatus,
  MobileGitStatusEntry,
  MobileGitStatusResult
} from './mobile-git-status'

export type ScreenState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: MobileGitStatusResult }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }

export type LoadStatusOptions = {
  preserveReadyOnFailure?: boolean
  clearActionErrorOnSuccess?: boolean
  force?: boolean
}

export type StatusLoadInFlight = {
  key: string
  client: unknown
  promise: Promise<boolean>
}

export type GitRequestError = Error & { code?: string }
export type GitCommitResult = { success: boolean; error?: string }

export type MobileGitStatusEntryView = MobileGitStatusEntry & {
  canDiscard: boolean
  canOpen: boolean
  canStage: boolean
  discardActionId: string
  stageActionId: string
  unstageActionId: string
}

export type MobileBranchCompareState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; result: MobileGitBranchCompareResult }
  | { kind: 'error'; message: string }

export type MobileBranchEntryView = MobileGitBranchChangeEntry & {
  canOpen: boolean
}

export type MobileBranchDiffPreviewState =
  | { kind: 'loading'; entry: MobileGitBranchChangeEntry }
  | {
      kind: 'ready'
      entry: MobileGitBranchChangeEntry
      summary: MobileGitBranchCompareSummary
      lines: MobileHighlightedDiffLine<MobileDiffLine>[]
      truncated: boolean
    }
  | { kind: 'error'; entry: MobileGitBranchChangeEntry; message: string }

export type GitDiffTextResult = {
  kind: 'text'
  originalContent: string
  modifiedContent: string
}

export const KEYBOARD_COMMIT_BAR_CLEARANCE = 10

export const SOURCE_CONTROL_ACTION_ICONS: Record<MobileSourceControlActionIcon, LucideIcon> = {
  commit: Check,
  push: ArrowUp,
  pull: ArrowDown,
  sync: ArrowDownUp,
  fetch: RefreshCw,
  publish: CloudUpload,
  rebase: GitBranch,
  pr: GitPullRequestArrow,
  branch: GitBranch,
  history: History
}

export const SELECTOR_RETRY_COUNT = 3
export const SELECTOR_RETRY_DELAY_MS = 250

export function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function formatBranchLabel(branch: string | undefined, head: string | undefined): string {
  if (branch?.startsWith('refs/heads/')) {
    return branch.slice('refs/heads/'.length)
  }
  return branch || head?.slice(0, 7) || 'No branch'
}

export function statusColor(status: MobileGitFileStatus): string {
  switch (status) {
    case 'added':
    case 'copied':
      return colors.statusGreen
    case 'deleted':
      return colors.statusRed
    case 'renamed':
      return colors.accentBlue
    case 'untracked':
      return colors.statusAmber
    case 'modified':
    default:
      return colors.textSecondary
  }
}
