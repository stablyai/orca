import { paneAgentIdentity } from '../../../agent-hooks/server/pane-agent-identity'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { agentProviderSessionsEqual } from '../../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { isLocalHookConnectionId } from '../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { isWorkspaceSleepRecord } from '../../../../shared/workspace/lifecycle/workspace-sleep'
import { launchStatement, type PtyLaunchFacts } from '../launch/launch-evidence'
import { agentPaneSleepStatus } from '../../../../shared/agent-status/lifecycle/agent-pane-sleep-status'
import { agentVerdictFields } from '../../../../shared/agent-status/lifecycle/agent-main-agent-verdict'

/** Per slept PTY: the resume records captured, and the panes the hook store proves moved on. */
export type WorktreeSleepResumeCapture = Map<
  string,
  {
    retiredPaneKeys: string[]
    records: SleepingAgentSessionRecord[]
    /** Main can't tell this PTY's launch, so a record keeps an earlier capture's same-session note. */
    launchUnknown?: boolean
  }
>

/** Captures before a host-driven sleep stops its PTYs and persists for the ones proven stopped. */
export type WorktreeSleepResumeRecorder = {
  capture(worktreeId: string, ptyIds: ReadonlySet<string>): Promise<WorktreeSleepResumeCapture>
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
  readRowsForPane: (paneKey: string) => readonly AgentStatusIpcPayload[]
  readSavedRecord?: (paneKey: string) => Promise<SleepingAgentSessionRecord | undefined>
  /** `savedRecord` null: read and absent. */
  readIdentity?: (
    paneKey: string,
    savedRecord?: SleepingAgentSessionRecord | null
  ) => ReturnType<typeof paneAgentIdentity>
  checkAgentPresence:
    | ((paneKey: string, exitedSince?: number) => Promise<AgentProcessVerdict | null>)
    | null
  capturedAt: number
}): Promise<WorktreeSleepResumeCapture> {
  const capture: WorktreeSleepResumeCapture = new Map()
  for (const [ptyId, keys] of args.paneKeysByPtyId) {
    const panes = [...new Set(keys)].flatMap((paneKey) => {
      const pane = parsePaneKey(paneKey)
      return pane ? [{ paneKey, tabId: pane.tabId }] : []
    })
    const records: SleepingAgentSessionRecord[] = []
    const retiredPaneKeys: string[] = []
    const launch = args.launchByPtyId.get(ptyId)
    let launchUnknown = false
    for (const { paneKey, tabId } of panes) {
      const savedBeforeProbe = await args.readSavedRecord?.(paneKey)
      const presence = await args
        .checkAgentPresence?.(paneKey, savedBeforeProbe?.updatedAt ?? 0)
        .catch(() => null)
      const savedRecord = await args.readSavedRecord?.(paneKey)
      const identity = args.readIdentity
        ? args.readIdentity(paneKey, savedRecord ?? (args.readSavedRecord ? null : undefined))
        : paneAgentIdentity({
            paneKey,
            row: args.readRowsForPane(paneKey).find((candidate) => candidate.paneKey === paneKey),
            savedRecord,
            worktreeId: args.worktreeId,
            ended: presence === 'exited'
          })
      if (
        identity?.ended ||
        identity?.executionHost === 'shared' ||
        (presence === 'exited' && !identity?.status.paneSleep)
      ) {
        retiredPaneKeys.push(paneKey)
        continue
      }
      const row = identity?.status
      const agent = row?.agentType
      const providerSession = normalizeAgentProviderSession(row?.providerSession)
      if (!row) {
        continue
      }
      if (!isResumableTuiAgent(agent) || !providerSession) {
        retiredPaneKeys.push(paneKey)
        continue
      }
      const statement = launchStatement(launch, agent)
      launchUnknown ||= statement === undefined
      const launchConfig = statement ?? undefined
      records.push({
        paneKey,
        tabId,
        worktreeId: args.worktreeId,
        agent,
        providerSession,
        prompt: row.prompt,
        // Why done: a pane-owned capture whose `--resume` waits for the tab open (#11598).
        state: 'done',
        ...agentVerdictFields(agentPaneSleepStatus(row, args.capturedAt)),
        capturedAt: args.capturedAt,
        updatedAt: row.receivedAt,
        origin: 'worktree-sleep',
        restoreOnTabOpenOnly: true,
        // Why: the SSH host boundary keeps the id off another machine; a WSL relay tag is local transport.
        connectionId: isLocalHookConnectionId(row.connectionId) ? null : row.connectionId,
        ...(launchConfig ? { launchConfig } : {})
      })
    }
    capture.set(ptyId, {
      retiredPaneKeys,
      records,
      ...(launchUnknown ? { launchUnknown } : {})
    })
  }
  return capture
}

/** Whether the record's pane still exists, bound to the stopped terminal or to none. */
function paneStillHeldBy(
  session: WorkspaceSessionState,
  record: SleepingAgentSessionRecord,
  ptyId: string
): boolean {
  const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId
  const row = tabId && session.tabsByWorktree?.[record.worktreeId]?.find((tab) => tab.id === tabId)
  if (!row) {
    return false
  }
  const layout = session.terminalLayoutsByTabId?.[row.id]
  const leafId = parsePaneKey(record.paneKey)?.leafId
  const bound = layout ? (leafId ? layout.ptyIdsByLeafId?.[leafId] : undefined) : row.ptyId
  return !bound || bound === ptyId
}

/** The session with the stopped panes' records replaced, or null when nothing changes. */
export function applyWorktreeSleepResumeRecords(
  session: WorkspaceSessionState,
  capture: WorktreeSleepResumeCapture,
  stoppedPtyIds: readonly string[]
): WorkspaceSessionState | null {
  const next = { ...session.sleepingAgentSessionsByPaneKey }
  let changed = false
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
      // A tab close or another terminal took the pane while the stop ran: its saved state is theirs.
      if (!paneStillHeldBy(session, record, ptyId)) {
        continue
      }
      // Only a terminal main can't tell about keeps an earlier capture's recipe for the same session.
      const previous = next[record.paneKey]
      const keptLaunchConfig =
        entry?.launchUnknown &&
        !record.launchConfig &&
        previous?.launchConfig &&
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
