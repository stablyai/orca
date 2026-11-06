import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { isFreshNonDoneAgentStatus } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'

export type AgentSwitchRow = Pick<
  AgentStatusIpcPayload,
  | 'paneKey'
  | 'tabId'
  | 'terminalHandle'
  | 'worktreeId'
  | 'connectionId'
  | 'state'
  | 'workingMode'
  | 'agentType'
  | 'receivedAt'
  | 'evidenceObservedAt'
  | 'restoredUnconfirmed'
  | 'providerSessionOnly'
  | 'structuredHost'
>

type TerminalRef = Pick<AgentSwitchRow, 'paneKey' | 'tabId' | 'terminalHandle'>

type BlockerArgs = {
  checkoutPath: string
  readRows: () => readonly AgentSwitchRow[]
  /** The rows the host holds for one pane right now, read by key. */
  readPaneRows: (paneKey: string) => readonly AgentSwitchRow[]
  pathOfWorktree: (worktreeId: string) => string | undefined
  /** Built once per switch from this checkout's candidates: is a terminal row's terminal still live? */
  buildTerminalLiveness: (candidates: readonly AgentSwitchRow[]) => (row: TerminalRef) => boolean
  probeProcess: (paneKey: string) => Promise<AgentProcessVerdict | null>
  now?: () => number
}

/** A busy agent of this host whose workspace is the checkout or a folder inside it. */
function isBusyInCheckout(row: AgentSwitchRow, args: BlockerArgs): boolean {
  if (row.state === 'done' || row.restoredUnconfirmed === true || row.providerSessionOnly) {
    return false
  }
  // Relayed rows describe another machine's checkout, even when the path text matches.
  if (!isLocalHookConnectionId(row.connectionId)) {
    return false
  }
  const path = row.worktreeId ? args.pathOfWorktree(row.worktreeId) : undefined
  return path !== undefined && isPathInsideOrEqual(args.checkoutPath, path)
}

function isRecent(row: AgentSwitchRow, now: number): boolean {
  return isFreshNonDoneAgentStatus(
    {
      state: row.state,
      updatedAt: row.receivedAt,
      evidenceObservedAt: row.evidenceObservedAt,
      restoredUnconfirmed: row.restoredUnconfirmed,
      ...(row.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {})
    },
    now
  )
}

function blockerMessage(row: AgentSwitchRow, onlyProcessIsLive: boolean): string {
  const agent = formatAgentTypeLabel(row.agentType)
  if (onlyProcessIsLive) {
    return `${agent} last reported work in this workspace and is still running. Stop or exit it, then switch branches.`
  }
  if (row.workingMode === 'monitoring') {
    return `${agent} is running a background task in this workspace. Stop it or wait for it to finish, then switch branches.`
  }
  if (row.state !== 'working') {
    return `${agent} is waiting for your approval in this workspace. Answer or stop it, then switch branches.`
  }
  return `${agent} is working in this workspace. Wait for it to finish or stop it, then switch branches.`
}

/**
 * Switching files under a busy agent breaks its work. A busy row blocks while its evidence is
 * recent, or while Orca verifies that exact agent process is still running (a long silent tool).
 * A verified exit, or a newer row that is no longer busy here, releases it. Only this checkout's
 * rows reach liveness, probes and the keyed re-read; the snapshot is walked once per switch.
 */
export async function findAgentSwitchBlocker(args: BlockerArgs): Promise<string | null> {
  const now = args.now ?? Date.now
  const candidates = args.readRows().filter((row) => isBusyInCheckout(row, args))
  if (candidates.length === 0) {
    return null
  }
  const isLive = args.buildTerminalLiveness(candidates)
  // Like the sidebar: a closed terminal's row no longer describes a running agent.
  const admitted = (row: AgentSwitchRow): boolean =>
    isBusyInCheckout(row, args) &&
    (row.structuredHost !== undefined || row.tabId === undefined || isLive(row))
  const probed = candidates.filter(admitted)
  const verdicts = await Promise.all(
    probed.map((row) => args.probeProcess(row.paneKey).catch(() => null))
  )
  // The probes are async; only each pane's current row decides, judged again in full.
  for (const [index, row] of probed.entries()) {
    const verdict = verdicts[index]
    const latest = args.readPaneRows(row.paneKey).find(admitted)
    if (verdict === 'exited' || !latest) {
      continue
    }
    const recent = isRecent(latest, now())
    if (recent || verdict === 'live') {
      return blockerMessage(latest, !recent)
    }
  }
  return null
}
