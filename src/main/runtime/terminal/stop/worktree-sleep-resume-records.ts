import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-ipc-payload'
import type { AgentProcessVerdict } from '../../../../shared/agent-process-presence'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { isWorkspaceSleepRecord } from '../../../../shared/workspace-sleep'

/** Per slept PTY: the resume records captured, and the panes the hook store proves moved on. */
export type WorktreeSleepResumeCapture = Map<
  string,
  { retiredPaneKeys: string[]; records: SleepingAgentSessionRecord[] }
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
  /** The agent each PTY was launched as, with its recipe; resume must reuse a custom binary/args. */
  launchByPtyId: ReadonlyMap<
    string,
    { agent: string | null; config: SleepingAgentLaunchConfig | null }
  >
  /** Read after each presence probe, so a conversation started during it is the one captured. */
  readRows: () => readonly AgentStatusIpcPayload[]
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
    for (const { paneKey, tabId } of panes) {
      // Why: the one holder rule — an agent the hook store proved exited left a plain shell.
      if ((await args.checkAgentPresence?.(paneKey, 0).catch(() => null)) === 'exited') {
        retiredPaneKeys.push(paneKey)
        continue
      }
      const row = args.readRows().find((candidate) => candidate.paneKey === paneKey)
      const agent = row?.agentType
      const providerSession = normalizeAgentProviderSession(row?.providerSession)
      if (!row) {
        continue
      }
      if (!isResumableTuiAgent(agent) || !providerSession) {
        // Why: the hook store names another agent here now, so an older capture no longer applies.
        retiredPaneKeys.push(paneKey)
        continue
      }
      records.push({
        paneKey,
        tabId,
        worktreeId: args.worktreeId,
        agent,
        providerSession,
        prompt: row.prompt,
        // Why done: a pane-owned capture whose `--resume` waits for the tab open (#11598).
        state: 'done',
        capturedAt: args.capturedAt,
        updatedAt: row.receivedAt,
        origin: 'worktree-sleep',
        restoreOnTabOpenOnly: true,
        // Why: the SSH host boundary keeps the id off another machine; a WSL relay tag is local transport.
        connectionId: isLocalHookConnectionId(row.connectionId) ? null : row.connectionId,
        ...(launch?.config && launch.agent === agent ? { launchConfig: launch.config } : {})
      })
    }
    capture.set(ptyId, { retiredPaneKeys, records })
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
      const previous = next[record.paneKey]
      // Reattach can lose launch recipes; retain an earlier capture's config for the same session.
      const keptLaunchConfig =
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
