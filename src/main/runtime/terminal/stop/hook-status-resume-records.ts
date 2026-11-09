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
  isPaneSleepRecord,
  normalizeAgentProviderSession,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'
import type { CommandOf } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** The part of a pane's previous status the next one may inherit its provider session from. */
export type PreviousHookStatus = Pick<ResumeRecordStatus, 'agentType' | 'state' | 'providerSession'>

/** Main's word on a pane's launch as `agent`: its note, null for none, undefined when main can't tell. */
export type PaneLaunchConfigOf = (
  paneKey: string,
  agent: ResumeRecordStatus['agentType']
) => SleepingAgentLaunchConfig | null | undefined

/** Main's word on the launch, else the pane's earlier record of this session when main can't tell.
 *  A deliberate sleep's snapshot keeps its recipe past the launch it was captured from. */
function statusLaunchConfig(
  statement: SleepingAgentLaunchConfig | null | undefined,
  existing: SleepingAgentSessionRecord | undefined,
  status: ResumeRecordStatus,
  keepsEarlier = true
): SleepingAgentLaunchConfig | undefined {
  const earlier =
    statement === undefined
      ? keepsEarlier
      : statement === null && existing && isPaneSleepRecord(existing)
  return earlier ? recordLaunchConfigForStatus(existing, status) : (statement ?? undefined)
}

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
    launchConfig: statusLaunchConfig(
      args.launchConfigOf(status.paneKey, status.agentType),
      existing,
      status,
      status.state !== 'done' || retainsResumableIdentity
    )
  })
  const change = liveResumeRecordChange(existing, live)
  if (!change) {
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
        statusLaunchConfig(args.launchConfigOf(status.paneKey, status.agentType), existing, status)
    })
    // Only a pane this partition holds keeps a record here.
    return record && tabFor(record.worktreeId) ? [record] : []
  })
}
