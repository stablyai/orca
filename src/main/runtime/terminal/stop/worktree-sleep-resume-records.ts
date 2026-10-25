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

/**
 * Builds the records a host-driven sleep leaves behind, from the host's own hook store.
 * Why: a paired client's sleep stops the host's PTYs, but the record its renderer writes never
 * reaches the host — and the host is the side that answers the tab open (session.tabs.activate),
 * so without these the reopened tab is a plain shell.
 */
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
      // Why: only hook evidence retires an older capture; a missing hook row (an agent still
      // starting after a resume) is no evidence the session left the pane.
      if (next[paneKey]) {
        delete next[paneKey]
        changed = true
      }
    }
    for (const record of entry?.records ?? []) {
      const previous = next[record.paneKey]
      // Why: a reattached PTY forgets its launch recipe; the earlier capture of this session kept it.
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
