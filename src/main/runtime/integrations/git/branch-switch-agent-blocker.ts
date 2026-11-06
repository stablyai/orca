import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { isFreshNonDoneAgentStatus } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentProcessVerdict } from '../../../../shared/agent-status/process/agent-process-presence'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { isLocalHookConnectionId } from '../../../../shared/wsl-hook-relay-contract'

type AgentRow = Pick<
  AgentStatusIpcPayload,
  | 'paneKey'
  | 'tabId'
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

type BlockerArgs = {
  checkoutPath: string
  readRows: () => readonly AgentRow[]
  pathOfWorktree: (worktreeId: string) => string | undefined
  /** Whether a terminal row's pane or tab still has a connected terminal on this host. */
  hasLiveTerminal: (row: Pick<AgentRow, 'paneKey' | 'tabId'>) => boolean
  probeProcess: ((paneKey: string) => Promise<AgentProcessVerdict | null>) | null
  now?: () => number
}

/** A busy agent of this host whose workspace is the checkout or a folder inside it. */
function isBusyInCheckout(row: AgentRow, args: BlockerArgs): boolean {
  if (row.state === 'done' || row.restoredUnconfirmed === true || row.providerSessionOnly) {
    return false
  }
  // Relayed rows describe another machine's checkout, even when the path text matches.
  if (!isLocalHookConnectionId(row.connectionId)) {
    return false
  }
  // Like the sidebar: a closed terminal's row no longer describes a running agent.
  if (row.structuredHost === undefined && row.tabId !== undefined && !args.hasLiveTerminal(row)) {
    return false
  }
  const path = row.worktreeId ? args.pathOfWorktree(row.worktreeId) : undefined
  return path !== undefined && isPathInsideOrEqual(args.checkoutPath, path)
}

function isRecent(row: AgentRow, now: number): boolean {
  return isFreshNonDoneAgentStatus(
    {
      state: row.state,
      updatedAt: row.receivedAt,
      evidenceObservedAt: row.evidenceObservedAt,
      restoredUnconfirmed: row.restoredUnconfirmed,
      structuredHostOwned: row.structuredHost === 'owned'
    },
    now
  )
}

function blockerMessage(row: AgentRow, onlyProcessIsLive: boolean): string {
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
 * A verified exit, or a newer row that is no longer busy here, releases it.
 */
export async function findAgentSwitchBlocker(args: BlockerArgs): Promise<string | null> {
  const now = args.now ?? Date.now
  for (const row of args.readRows().filter((candidate) => isBusyInCheckout(candidate, args))) {
    const verdict = (await args.probeProcess?.(row.paneKey).catch(() => null)) ?? null
    if (verdict === 'exited') {
      continue
    }
    // The probe is async; only the pane's latest row decides, judged again in full.
    const latest = args.readRows().find((candidate) => candidate.paneKey === row.paneKey)
    if (!latest || !isBusyInCheckout(latest, args)) {
      continue
    }
    const recent = isRecent(latest, now())
    if (recent || verdict === 'live') {
      return blockerMessage(latest, !recent)
    }
  }
  return null
}
