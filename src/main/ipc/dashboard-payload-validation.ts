import {
  DASHBOARD_MAX_LABEL_LENGTH,
  type DashboardRevealAgentArgs,
  type DashboardSleepWorkspaceArgs,
  type DashboardSnapshot
} from '../../shared/dashboard-snapshot'
import { BoundedMap } from '../../shared/bounded-map'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import { sanitizeRepoIcon } from '../../shared/repo-icon'
import {
  AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH,
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  AGENT_STATUS_MAX_FIELD_LENGTH,
  AGENT_TYPE_MAX_LENGTH
} from '../../shared/agent-status-types'
import { isDashboardLaunchOptions } from './dashboard-agent-launch-validation'
import {
  admitDashboardWorkspaces,
  isDashboardWorkspaceList
} from './dashboard-workspace-payload-validation'
import { isDashboardFilterOptions } from './dashboard-filter-payload-validation'
export { isDashboardSpawnAgentArgs } from './dashboard-agent-launch-validation'

const MAX_DASHBOARD_CARDS = 1_000
const MAX_DASHBOARD_SUBAGENTS = 100
const MAX_DASHBOARD_REPO_ICONS = 500
// Why: sanitizing an image icon base64-decodes the whole data URI to read a
// 24-byte header, and the renderer republishes the same icons every 250 ms.
const MAX_CACHED_ICON_SRC_BYTES = 8 * 1024 * 1024
const imageIconValidity = new BoundedMap<string, boolean>({
  maxEntries: MAX_DASHBOARD_REPO_ICONS,
  maxBytes: MAX_CACHED_ICON_SRC_BYTES,
  sizeOf: (_valid, key) => key.length * 2
})
const MAX_ID_LENGTH = 4_096
const MAX_LABEL_LENGTH = DASHBOARD_MAX_LABEL_LENGTH
const DASHBOARD_BUCKETS = new Set(['attention', 'working', 'done', 'idle'])
const DASHBOARD_DOT_STATES = new Set(['working', 'blocked', 'waiting', 'done', 'idle'])
const DASHBOARD_HOST_KINDS = new Set(['local', 'ssh', 'wsl', 'remote'])
const DASHBOARD_WORKSPACE_KINDS = new Set(['worktree', 'folder'])
const DASHBOARD_REVIEW_STATES = new Set(['open', 'closed', 'merged', 'draft'])
const DASHBOARD_HOST_PLATFORMS = new Set([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32'
])
const WINDOWS_SHIFT_ENTER_ENCODINGS = new Set(['alt-enter', 'csi-u'])

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength, true)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isDashboardRevealAgentArgs(value: unknown): value is DashboardRevealAgentArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const args = value as Record<string, unknown>
  return (
    isBoundedString(args.repoId, MAX_ID_LENGTH) &&
    isBoundedString(args.worktreeId, MAX_ID_LENGTH) &&
    (args.executionHostId === undefined ||
      (isBoundedString(args.executionHostId, MAX_ID_LENGTH) &&
        normalizeExecutionHostId(args.executionHostId) !== null)) &&
    isBoundedString(args.tabId, MAX_ID_LENGTH) &&
    (args.leafId === null || isBoundedString(args.leafId, MAX_ID_LENGTH))
  )
}

export function isDashboardPaneKey(value: unknown): value is string {
  return isBoundedString(value, MAX_ID_LENGTH)
}

export function isDashboardSleepWorkspaceArgs(
  value: unknown
): value is DashboardSleepWorkspaceArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  return isBoundedString((value as Record<string, unknown>).worktreeId, MAX_ID_LENGTH)
}

export function isDashboardSnapshot(value: unknown): value is DashboardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const snapshot = value as Record<string, unknown>
  return (
    isFiniteNumber(snapshot.generatedAt) &&
    Array.isArray(snapshot.cards) &&
    snapshot.cards.length <= MAX_DASHBOARD_CARDS &&
    snapshot.cards.every(isDashboardCard) &&
    isDashboardWorkspaceList(snapshot.workspaces) &&
    (snapshot.showIdle === undefined || typeof snapshot.showIdle === 'boolean') &&
    isDashboardFilterOptions(snapshot.filterOptions) &&
    isDashboardLaunchOptions(snapshot.launchableAgentsByWorktreeId) &&
    isDashboardRepoIcons(snapshot.repoIconsByRepoId)
  )
}

export type DashboardSnapshotAdmission = {
  snapshot: DashboardSnapshot
  /** Cards dropped for failing validation; the rest of the board still paints. */
  droppedCardCount: number
}

/**
 * Why: one malformed card used to reject the whole snapshot, and the pop-out
 * then replayed its last good board forever with nothing logged. A single
 * over-long label must cost that card, not every other agent's live status.
 * Snapshot-level fields still reject outright — there is no partial board to
 * salvage when the frame itself is unusable.
 */
export function admitDashboardSnapshot(value: unknown): DashboardSnapshotAdmission | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const snapshot = value as Record<string, unknown>
  const workspaces = admitDashboardWorkspaces(snapshot.workspaces)
  if (
    !isFiniteNumber(snapshot.generatedAt) ||
    !Array.isArray(snapshot.cards) ||
    snapshot.cards.length > MAX_DASHBOARD_CARDS ||
    workspaces === null ||
    (snapshot.showIdle !== undefined && typeof snapshot.showIdle !== 'boolean') ||
    !isDashboardFilterOptions(snapshot.filterOptions) ||
    !isDashboardLaunchOptions(snapshot.launchableAgentsByWorktreeId) ||
    !isDashboardRepoIcons(snapshot.repoIconsByRepoId)
  ) {
    return null
  }
  const cards = snapshot.cards.filter(isDashboardCard)
  return {
    snapshot: {
      ...(snapshot as unknown as DashboardSnapshot),
      cards,
      ...(workspaces ? { workspaces } : {})
    },
    droppedCardCount: snapshot.cards.length - cards.length
  }
}

/** Repo icons reach the pop-out's `<img src>`, so each one must survive the
 *  same sanitizer the settings picker writes through. */
function isDashboardRepoIcons(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const entries = Object.entries(value as Record<string, unknown>)
  return (
    entries.length <= MAX_DASHBOARD_REPO_ICONS &&
    entries.every(
      ([repoId, icon]) => isBoundedString(repoId, MAX_ID_LENGTH) && (icon === null || isIcon(icon))
    )
  )
}

function isDashboardReview(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const review = value as Record<string, unknown>
  return (
    isFiniteNumber(review.number) &&
    review.number > 0 &&
    typeof review.state === 'string' &&
    DASHBOARD_REVIEW_STATES.has(review.state)
  )
}

function isDashboardSubagents(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  return (
    Array.isArray(value) &&
    value.length <= MAX_DASHBOARD_SUBAGENTS &&
    value.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return false
      }
      const subagent = entry as Record<string, unknown>
      return (
        isBoundedString(subagent.id, MAX_ID_LENGTH) &&
        isBoundedString(subagent.name, MAX_LABEL_LENGTH, true) &&
        typeof subagent.dotState === 'string' &&
        DASHBOARD_DOT_STATES.has(subagent.dotState)
      )
    })
  )
}

/** Memoizes only the image branch, whose cost is proportional to payload size. */
function isIcon(icon: unknown): boolean {
  const key = imageIconCacheKey(icon)
  if (key === null) {
    return sanitizeRepoIcon(icon) !== undefined
  }
  const cached = imageIconValidity.get(key)
  if (cached !== undefined) {
    return cached
  }
  const valid = sanitizeRepoIcon(icon) !== undefined
  imageIconValidity.set(key, valid)
  return valid
}

/** Cache key for an image icon; null when the verdict is already cheap. */
function imageIconCacheKey(icon: unknown): string | null {
  if (!icon || typeof icon !== 'object' || Array.isArray(icon)) {
    return null
  }
  const candidate = icon as Record<string, unknown>
  // Why: `source` and `src` are the only fields an image icon can be rejected
  // on — `label` is normalized rather than rejected — so they alone key it.
  // Length-prefixed because a valid `src` may contain whitespace, so a plain
  // separator would let a rejected icon collide with an accepted one's verdict.
  return candidate.type === 'image' &&
    typeof candidate.src === 'string' &&
    typeof candidate.source === 'string'
    ? `${candidate.source.length}:${candidate.source}${candidate.src}`
    : null
}

function isDashboardCard(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const card = value as Record<string, unknown>
  return (
    isBoundedString(card.paneKey, MAX_ID_LENGTH) &&
    (card.ptyId === null || isBoundedString(card.ptyId, MAX_ID_LENGTH)) &&
    isBoundedString(card.agentType, AGENT_TYPE_MAX_LENGTH) &&
    typeof card.bucket === 'string' &&
    DASHBOARD_BUCKETS.has(card.bucket) &&
    typeof card.dotState === 'string' &&
    DASHBOARD_DOT_STATES.has(card.dotState) &&
    isBoundedString(card.task, AGENT_STATUS_MAX_FIELD_LENGTH, true) &&
    isOptionalBoundedString(card.lastUserMessage, AGENT_STATUS_MAX_FIELD_LENGTH) &&
    isOptionalBoundedString(card.lastAgentMessage, AGENT_STATUS_ASSISTANT_MESSAGE_MAX_LENGTH) &&
    isBoundedString(card.repoId, MAX_ID_LENGTH) &&
    isBoundedString(card.worktreeId, MAX_ID_LENGTH) &&
    isBoundedString(card.tabId, MAX_ID_LENGTH) &&
    (card.leafId === null || isBoundedString(card.leafId, MAX_ID_LENGTH)) &&
    isOptionalBoundedString(card.parentPaneKey, MAX_ID_LENGTH) &&
    isOptionalBoundedString(card.parentWorktreeId, MAX_ID_LENGTH) &&
    isBoundedString(card.repoName, MAX_LABEL_LENGTH, true) &&
    isBoundedString(card.worktreeName, MAX_LABEL_LENGTH, true) &&
    (card.hostKind === undefined ||
      (typeof card.hostKind === 'string' && DASHBOARD_HOST_KINDS.has(card.hostKind))) &&
    (card.executionHostId === undefined ||
      (isBoundedString(card.executionHostId, MAX_ID_LENGTH) &&
        normalizeExecutionHostId(card.executionHostId) !== null)) &&
    (card.workspaceKind === undefined ||
      (typeof card.workspaceKind === 'string' &&
        DASHBOARD_WORKSPACE_KINDS.has(card.workspaceKind))) &&
    isOptionalBoundedString(card.workspaceStatusId, MAX_ID_LENGTH) &&
    isOptionalBoundedString(card.workspaceStatusLabel, MAX_LABEL_LENGTH) &&
    isOptionalBoundedString(card.workspaceStatusColor, MAX_ID_LENGTH) &&
    (card.hasReview === undefined || typeof card.hasReview === 'boolean') &&
    isDashboardReview(card.review) &&
    isDashboardSubagents(card.subagents) &&
    isFiniteNumber(card.startedAt) &&
    (card.finishedAt === null || isFiniteNumber(card.finishedAt)) &&
    isFiniteNumber(card.stateChangedAt) &&
    (card.statusUpdatedAt === undefined || isFiniteNumber(card.statusUpdatedAt)) &&
    typeof card.unseen === 'boolean' &&
    isOptionalBoundedString(card.askSummary, AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH) &&
    isOptionalBoundedString(card.conversationName, MAX_LABEL_LENGTH) &&
    isDashboardTerminalInput(card.terminalInput)
  )
}

function isDashboardTerminalInput(value: unknown): boolean {
  if (value === undefined) {
    return true
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const input = value as Record<string, unknown>
  return (
    typeof input.hostPlatform === 'string' &&
    DASHBOARD_HOST_PLATFORMS.has(input.hostPlatform) &&
    typeof input.localWindowsConpty === 'boolean' &&
    isOptionalBoundedString(input.osRelease, MAX_LABEL_LENGTH) &&
    typeof input.windowsShiftEnterEncoding === 'string' &&
    WINDOWS_SHIFT_ENTER_ENCODINGS.has(input.windowsShiftEnterEncoding) &&
    typeof input.ctrlEnterCsiU === 'boolean' &&
    typeof input.kittyKeyboardAdvertised === 'boolean'
  )
}
