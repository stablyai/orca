import {
  canReuseStatusProviderSession,
  capturedResumeRecord,
  liveResumeRecord,
  liveResumeRecordChange,
  recordLaunchConfigForStatus,
  statusRetainsResumableIdentity,
  type ResumeRecordStatus,
  type ResumeRecordTab
} from '../../../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import {
  normalizeAgentProviderSession,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { splitWorktreeIdForFilesystem, worktreeIdsEqual } from '../../../../shared/worktree/id'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'
import type { CommandOf } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** The part of a pane's previous status the next one may inherit its provider session from. */
export type PreviousHookStatus = Pick<ResumeRecordStatus, 'agentType' | 'state' | 'providerSession'>

/** A pane's agent launch recipe, when its terminal was launched as `agent`. */
export type PaneLaunchConfigOf = (
  paneKey: string,
  agent: ResumeRecordStatus['agentType']
) => SleepingAgentLaunchConfig | undefined

/** A hook row as the window's status entry reads it; null for rows that are not a pane's status. */
export function resumeStatusFromHookRow(
  row: AgentStatusIpcPayload,
  previous: PreviousHookStatus | undefined
): ResumeRecordStatus | null {
  if (row.providerSessionOnly || row.structuredHost) {
    return null
  }
  const providerSession =
    normalizeAgentProviderSession(row.providerSession) ??
    (canReuseStatusProviderSession(previous, row) ? previous.providerSession : undefined)
  return {
    paneKey: row.paneKey,
    agentType: row.agentType,
    state: row.state,
    prompt: row.prompt,
    updatedAt: row.receivedAt,
    ...(providerSession ? { providerSession } : {}),
    // Why: the SSH host boundary keeps the id; a WSL relay tag is local transport.
    connectionId: isLocalHookConnectionId(row.connectionId) ? null : row.connectionId,
    lastAssistantMessage: row.lastAssistantMessage,
    interrupted: row.interrupted,
    ...(row.mainAgent ? { mainAgent: row.mainAgent } : {}),
    ...(row.worktreeId ? { worktreeId: row.worktreeId } : {})
  }
}

function tabOf(
  session: WorkspaceSessionState,
  paneKey: string
): (worktreeId: string) => ResumeRecordTab | undefined {
  const tabId = parsePaneKey(paneKey)?.tabId
  return (worktreeId) => session.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)
}

/** Whether a hook-reported agent folder lies inside another worktree that has its own tabs in the
 *  same window session. A long-lived tmux server (or any env-freezing ancestor) hands every session
 *  it spawns the creating pane's identity, so a hook's claimed pane key and worktree are inherited
 *  claims, while the conversation folder the agent itself reports is not: a folder inside another
 *  tabbed worktree marks a hook that never ran in the claimed pane (#37799). */
export function cwdInsideOtherTabbedWorktree(
  session: Pick<WorkspaceSessionState, 'tabsByWorktree'> | null | undefined,
  worktreeId: string,
  cwd: string | null | undefined
): boolean {
  const folder = cwd ? normalizeRuntimePathForComparison(cwd) : ''
  if (!folder) {
    return false
  }
  const ownPath = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  const own = ownPath ? normalizeRuntimePathForComparison(ownPath) : ''
  for (const otherId of Object.keys(session?.tabsByWorktree ?? {})) {
    if (worktreeIdsEqual(otherId, worktreeId)) {
      continue
    }
    const otherPath = splitWorktreeIdForFilesystem(otherId)?.worktreePath
    const other = otherPath ? normalizeRuntimePathForComparison(otherPath) : ''
    if (!other || !(folder === other || folder.startsWith(`${other}/`))) {
      continue
    }
    // Longest matching worktree path owns the folder: when this pane's worktree nests below the
    // other tabbed worktree, its own match is the longer prefix, so a cwd inside the pane's own
    // tree stays theirs instead of reading as foreign (#37799).
    const ownMatchLength = own && (folder === own || folder.startsWith(`${own}/`)) ? own.length : -1
    if (other.length > ownMatchLength) {
      return true
    }
  }
  return false
}

/**
 * The record-only sleep or wake that applies a hook status to the resume record of a pane the
 * partition holds, by the window's rule; null when the record stays as it is.
 */
export function hookStatusResumeCommand(args: {
  status: ResumeRecordStatus
  session: WorkspaceSessionState
  worktreeId: string
  launchConfigOf: PaneLaunchConfigOf
}): ((CommandOf<'sleep'> | CommandOf<'wake'>) & { tabId: string }) | null {
  const { status, session, worktreeId } = args
  const tab = tabOf(session, status.paneKey)(worktreeId)
  if (!tab) {
    return null
  }
  const existing = session.sleepingAgentSessionsByPaneKey?.[status.paneKey]
  const retainsResumableIdentity = statusRetainsResumableIdentity(status, status.providerSession)
  const live = liveResumeRecord({
    entry: status,
    retainsResumableIdentity,
    worktreeIdOf: () => worktreeId,
    tabOf: () => tab,
    capturedAt: status.updatedAt,
    launchConfig:
      args.launchConfigOf(status.paneKey, status.agentType) ??
      (status.state !== 'done' || retainsResumableIdentity
        ? recordLaunchConfigForStatus(existing, status)
        : undefined)
  })
  const change = liveResumeRecordChange(existing, live)
  if (!change) {
    return null
  }
  // A hook whose conversation folder belongs to another tabbed worktree speaks through inherited
  // pane identity; it must leave this pane's record exactly as it is (#37799).
  if (cwdInsideOtherTabbedWorktree(session, worktreeId, status.providerSession?.cwd)) {
    return null
  }
  const target = { workspace: worktreeId, tabId: tab.id, paneKeys: [status.paneKey] }
  return change === 'clear'
    ? { type: 'wake', ...target, recordOnly: true }
    : { type: 'sleep', ...target, records: [change.set], recordOnly: true }
}

/** The quit capture's records for the panes of one workspace the partition holds. */
export function quitResumeRecords(args: {
  statuses: readonly ResumeRecordStatus[]
  session: WorkspaceSessionState
  worktreeIdOf: (paneKey: string) => string | null
  launchConfigOf: PaneLaunchConfigOf
  capturedAt: number
}): SleepingAgentSessionRecord[] {
  return args.statuses.flatMap((status) => {
    const existing = args.session.sleepingAgentSessionsByPaneKey?.[status.paneKey]
    const tabFor = tabOf(args.session, status.paneKey)
    const record = capturedResumeRecord({
      entry: status,
      existing,
      mode: 'quit',
      capturedAt: args.capturedAt,
      worktreeIdOf: () => status.worktreeId ?? args.worktreeIdOf(status.paneKey),
      tabOf: tabFor,
      launchConfigOf: () =>
        args.launchConfigOf(status.paneKey, status.agentType) ??
        recordLaunchConfigForStatus(existing, status)
    })
    // A conversation from another tabbed worktree never replaces this pane's capture (#37799).
    if (
      record &&
      cwdInsideOtherTabbedWorktree(args.session, record.worktreeId, record.providerSession.cwd)
    ) {
      return []
    }
    // Only a pane this partition holds keeps a record here.
    return record && tabFor(record.worktreeId) ? [record] : []
  })
}
