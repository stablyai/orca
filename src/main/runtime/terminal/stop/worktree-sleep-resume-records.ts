import { displayOnlyPaneSleepFromEntry } from '../../../../shared/agent-session/lifecycle/pane-sleep-agent-status'
import { resumeRecordFromStatus } from '../../../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { paneBelongsToTerminalLayout } from '../../../../shared/workspace-session/workspace-session-pane-ownership'
import {
  agentProviderSessionsEqual,
  isResumablePaneRecord,
  type OwnedPaneAgentRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { isWorkspaceSleepRecord } from '../../../../shared/workspace-sleep'
import { launchStatement, type PtyLaunchFacts } from '../launch/launch-evidence'

/** Per slept PTY: the resume records captured, and the panes the hook store proves moved on. */
export type WorktreeSleepResumeCapture = Map<
  string,
  {
    retiredPaneKeys: string[]
    records: OwnedPaneAgentRecord[]
    /** Main can't tell this PTY's launch, so a record keeps an earlier capture's same-session note. */
    launchUnknown?: boolean
  }
>

export type WorktreeSleepRecordTransaction = {
  staged: boolean
  settle: (runningPtyIds: readonly string[]) => Promise<void>
}

/** Captures before a host-driven sleep stops its PTYs and persists for the ones proven stopped. */
export type WorktreeSleepResumeRecorder = {
  capture(worktreeId: string, ptyIds: ReadonlySet<string>): Promise<WorktreeSleepResumeCapture>
  prepare(
    worktreeId: string,
    capture: WorktreeSleepResumeCapture,
    isCurrent: () => boolean
  ): Promise<WorktreeSleepRecordTransaction>
  persist(
    worktreeId: string,
    capture: WorktreeSleepResumeCapture,
    stoppedPtyIds: string[]
  ): Promise<void>
}

/** Capture resume records on the host: paired-renderer saves never reach the host that later reopens the tab, leaving a plain shell without them. */
export async function captureWorktreeSleepResumeRecords(args: {
  worktreeId: string
  paneKeysByPtyId: ReadonlyMap<string, Iterable<string>>
  /** Each PTY's launch facts; only a launch main still holds supplies its recipe. */
  launchByPtyId: ReadonlyMap<string, PtyLaunchFacts | undefined>
  /** Read after each presence probe, so a conversation started during it is the one captured. */
  readRows: () => readonly AgentStatusIpcPayload[]
  checkAgentPresence:
    | ((paneKey: string, exitedSince?: number) => Promise<AgentProcessVerdict | null>)
    | null
  readEntry?: (ptyId: string, paneKey: string) => AgentStatusEntry | null
  capturedAt: number
}): Promise<WorktreeSleepResumeCapture> {
  const capture: WorktreeSleepResumeCapture = new Map()
  for (const [ptyId, keys] of args.paneKeysByPtyId) {
    const panes = [...new Set(keys)].flatMap((paneKey) => {
      const pane = parsePaneKey(paneKey)
      return pane ? [{ paneKey, tabId: pane.tabId }] : []
    })
    const records: OwnedPaneAgentRecord[] = []
    const retiredPaneKeys: string[] = []
    const launch = args.launchByPtyId.get(ptyId)
    let launchUnknown = false
    for (const { paneKey, tabId } of panes) {
      // Why: the one holder rule — an agent the hook store proved exited left a plain shell.
      if ((await args.checkAgentPresence?.(paneKey, 0).catch(() => null)) === 'exited') {
        retiredPaneKeys.push(paneKey)
        continue
      }
      let entry: AgentStatusEntry | null
      if (args.readEntry) {
        entry = args.readEntry(ptyId, paneKey)
      } else {
        const row = args
          .readRows()
          .filter((candidate) => candidate.paneKey === paneKey && !candidate.providerSessionOnly)
          .sort((a, b) => b.receivedAt - a.receivedAt)[0]
        entry = row
          ? {
              ...row,
              updatedAt: row.receivedAt,
              stateHistory: row.previousCompletion ? [row.previousCompletion.end] : [],
              lastCompletedAssistantMessage: row.previousCompletion?.lastAssistantMessage
            }
          : null
      }
      if (!entry) {
        continue
      }
      const agent = entry.agentType
      const statement = launchStatement(launch, agent)
      launchUnknown ||= statement === undefined
      const launchConfig = statement ?? undefined
      const resumable = resumeRecordFromStatus({
        entry,
        worktreeId: args.worktreeId,
        capturedAt: args.capturedAt,
        tabOf: () => ({ id: tabId }),
        origin: 'worktree-sleep',
        launchConfig
      })
      records.push(
        resumable
          ? {
              ...resumable,
              state: 'done',
              restoreOnTabOpenOnly: true,
              connectionId: isLocalHookConnectionId(entry.connectionId) ? null : entry.connectionId
            }
          : displayOnlyPaneSleepFromEntry(entry, args.worktreeId, args.capturedAt, tabId)
      )
    }
    capture.set(ptyId, {
      retiredPaneKeys,
      records,
      ...(launchUnknown ? { launchUnknown } : {})
    })
  }
  return capture
}

/** The session with the stopped panes' records replaced, or null when nothing changes. */
export function applyWorktreeSleepResumeRecords(
  session: WorkspaceSessionState,
  capture: WorktreeSleepResumeCapture,
  stoppedPtyIds: readonly string[]
): WorkspaceSessionState | null {
  const next = { ...session.sleepingAgentSessionsByPaneKey }
  let changed = false
  const tabs = new Set(
    Object.values(session.tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  for (const ptyId of stoppedPtyIds) {
    const entry = capture.get(ptyId)
    for (const paneKey of entry?.retiredPaneKeys ?? []) {
      // Only hook evidence retires captures; missing rows during agent startup cannot prove the session left.
      if (next[paneKey]) {
        delete next[paneKey]
        changed = true
      }
    }
    for (const record of entry?.records ?? []) {
      if (!paneBelongsToTerminalLayout(record, session, tabs)) {
        continue
      }
      // Only a terminal main can't tell about keeps an earlier capture's recipe for the same session.
      const previous = next[record.paneKey]
      const keptLaunchConfig =
        entry?.launchUnknown &&
        isResumablePaneRecord(record) &&
        !record.launchConfig &&
        previous &&
        isResumablePaneRecord(previous) &&
        previous.launchConfig &&
        previous.agent === record.agent &&
        agentProviderSessionsEqual(record.agent, previous.providerSession, record.providerSession)
          ? { launchConfig: previous.launchConfig }
          : {}
      next[record.paneKey] = { ...record, ...keptLaunchConfig }
      changed = true
    }
  }
  return changed ? { ...session, sleepingAgentSessionsByPaneKey: next } : null
}

/** The session with a closed worktree's resume records dropped; an Error while its terminals remain. */
export function clearClosedWorktreeResumeRecords(
  session: WorkspaceSessionState,
  worktreeId: string,
  closedTabIds: readonly string[]
): WorkspaceSessionState | Error | null {
  const sleepingAgentSessionsByPaneKey = Object.fromEntries(
    Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).filter(
      ([, record]) => record.worktreeId !== worktreeId
    )
  )
  const terminalPtyIncarnationsByPaneKey = Object.fromEntries(
    Object.entries(session.terminalPtyIncarnationsByPaneKey ?? {}).filter(
      ([paneKey]) => !closedTabIds.some((tabId) => paneKey.startsWith(`${tabId}:`))
    )
  )
  const remainingTerminalRows = session.tabsByWorktree[worktreeId] ?? []
  const remainingUnifiedTerminalTabs = (session.unifiedTabs?.[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal'
  )
  if (remainingTerminalRows.length > 0 || remainingUnifiedTerminalTabs.length > 0) {
    return new Error('terminal_close_incomplete')
  }
  const hasChanges =
    Object.keys(sleepingAgentSessionsByPaneKey).length !==
      Object.keys(session.sleepingAgentSessionsByPaneKey ?? {}).length ||
    Object.keys(terminalPtyIncarnationsByPaneKey).length !==
      Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).length
  return hasChanges
    ? { ...session, sleepingAgentSessionsByPaneKey, terminalPtyIncarnationsByPaneKey }
    : null
}

/** The session without a workspace-sleep record whose tab it no longer lists, or null when the record is still placed. */
export function dropStrandedSleepRecord(
  session: WorkspaceSessionState,
  worktreeId: string,
  paneKey: string
): WorkspaceSessionState | null {
  const record = session.sleepingAgentSessionsByPaneKey?.[paneKey]
  const tabId = record?.tabId ?? parsePaneKey(paneKey)?.tabId
  const tabListed = Object.values(session.tabsByWorktree).some((tabs) =>
    tabs.some((tab) => tab.id === tabId)
  )
  if (!record || record.worktreeId !== worktreeId || !isWorkspaceSleepRecord(record) || tabListed) {
    return null
  }
  const { [paneKey]: _dropped, ...rest } = session.sleepingAgentSessionsByPaneKey ?? {}
  return { ...session, sleepingAgentSessionsByPaneKey: rest }
}
