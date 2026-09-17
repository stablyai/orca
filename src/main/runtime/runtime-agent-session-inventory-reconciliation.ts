import type { PtyProcessInfo } from '../providers/types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { parseExecutionHostId } from '../../shared/execution-host'
import type { RuntimeAgentSessionInventoryReconciliation } from './runtime-terminal-contracts'
import { agentSessionOwners } from '../ipc/pty/pane/agent-session-owners'

/** Add host ids discovered in an aggregate inventory and publish its coverage. */
export function reconcileRuntimeAgentSessionInventory(args: {
  sessions: readonly PtyProcessInfo[]
  connectionId?: string | null
  queriedHostIds: Set<ExecutionHostId>
  knownHostIds: ReadonlySet<ExecutionHostId>
  onReconciled?: (reconciliation: RuntimeAgentSessionInventoryReconciliation) => void
}): void {
  if (args.connectionId === undefined) {
    for (const session of args.sessions) {
      const hostId = getPtyExecutionHost(session.id)
      if (hostId && hostId !== 'foreign' && parseExecutionHostId(hostId)?.kind === 'ssh') {
        args.queriedHostIds.add(hostId)
      }
    }
  }
  if (!args.onReconciled) {
    return
  }
  const owners = [
    ...args.sessions.flatMap((session) => session.agentSessionOwners ?? []),
    ...(args.connectionId === undefined || args.connectionId === null
      ? agentSessionOwners.list().filter((owner) => getPtyExecutionHost(owner.ptyId) === null)
      : [])
  ]
  const discoveries = args.sessions.flatMap((session) =>
    session.verifiedAgentDiscovery ? [session.verifiedAgentDiscovery] : []
  )
  const complete =
    args.connectionId !== undefined ||
    [...args.knownHostIds].every((hostId) => {
      const kind = parseExecutionHostId(hostId)?.kind
      return kind === 'runtime' || args.queriedHostIds.has(hostId)
    })
  try {
    args.onReconciled({ owners, discoveries, complete, connectionId: args.connectionId })
  } catch (error) {
    // Inventory-derived bookkeeping must not make a terminal listing fail.
    console.warn('[runtime] launch membership reconciliation failed:', error)
  }
}
