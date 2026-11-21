import type { RuntimeTerminalSummary } from '../../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from '../../../terminal/records/runtime-terminal-state-records'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { ExactWorkerProviderSession } from '../../../../../shared/orchestration/workers/orchestration-worker-output'
import {
  isWslHookRelayConnectionId,
  wslHookRelayConnectionId
} from '../../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'

export type WorkerSessionObservation =
  | number
  | Pick<RuntimeTerminalSummary, 'ptyId' | 'incarnationId'>

// A terminal inspection has no dispatch timestamp. Its live launch must match the snapshot.
export function matchesWorkerSessionObservation(
  observation: WorkerSessionObservation | undefined,
  pty: RuntimePtyWorktreeRecord | undefined
): boolean {
  if (typeof observation === 'number') {
    return true
  }
  if (!pty?.launchToken) {
    return false
  }
  return (
    !observation ||
    (pty.ptyId === observation.ptyId &&
      (observation.incarnationId == null || pty.incarnationId === observation.incarnationId))
  )
}

export function selectExactWorkerProviderSession(args: {
  paneKey: string
  processIncarnation: string
  connectionId: string | null | undefined
  wslDistro?: string | null
  launchToken: string | null | undefined
  observedAfter: number
  statuses: readonly AgentStatusIpcPayload[]
}): ExactWorkerProviderSession | null {
  const status = args.statuses
    .filter(
      (entry) =>
        entry.paneKey === args.paneKey &&
        terminalHostConnectionMatches(entry.connectionId, args.connectionId, args.wslDistro) &&
        (!args.launchToken || entry.launchToken === args.launchToken) &&
        entry.providerSessionOnly !== true &&
        entry.providerSession !== undefined &&
        entry.agentType !== undefined &&
        entry.receivedAt >= args.observedAfter
    )
    .sort((left, right) => right.receivedAt - left.receivedAt)[0]
  if (!status?.providerSession || !status.agentType) {
    return null
  }
  const wslDistro = attestedWslDistro(status.connectionId, args.wslDistro)
  const selected: ExactWorkerProviderSession = {
    paneKey: args.paneKey,
    processIncarnation: args.processIncarnation,
    connectionId: status.connectionId,
    ...(wslDistro ? { wslDistro } : {}),
    agent: status.agentType,
    providerSession: { ...status.providerSession },
    observedAt: status.receivedAt
  }
  return selected
}

function attestedWslDistro(
  connectionId: string | null,
  expectedDistro: string | null | undefined
): string | undefined {
  const distro = expectedDistro?.trim()
  return distro && connectionId === wslHookRelayConnectionId(distro) ? distro : undefined
}

export function terminalHostConnectionMatches(
  entryConnectionId: string | null,
  expectedConnectionId: string | null | undefined,
  wslDistro: string | null | undefined
): boolean {
  if (expectedConnectionId === undefined || entryConnectionId === expectedConnectionId) {
    return true
  }
  // WSL PTYs stay local; require their attested distro to avoid same-pane events from another guest.
  return (
    expectedConnectionId === null &&
    typeof wslDistro === 'string' &&
    wslDistro.trim().length > 0 &&
    isWslHookRelayConnectionId(entryConnectionId) &&
    entryConnectionId === wslHookRelayConnectionId(wslDistro.trim())
  )
}
