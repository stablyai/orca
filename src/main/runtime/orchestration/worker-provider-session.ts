import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { ExactWorkerProviderSession } from '../../../shared/orchestration-worker-output'
import {
  isWslHookRelayConnectionId,
  wslHookRelayConnectionId
} from '../../../shared/wsl-hook-relay-contract'

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
        connectionMatches(entry.connectionId, args.connectionId, args.wslDistro) &&
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

function connectionMatches(
  entryConnectionId: string | null,
  expectedConnectionId: string | null | undefined,
  wslDistro: string | null | undefined
): boolean {
  if (expectedConnectionId === undefined || entryConnectionId === expectedConnectionId) {
    return true
  }
  // WSL hook relays stamp their distro on the event, while the host PTY stays
  // local (connectionId null). Require the PTY's known distro to avoid mixing
  // same-pane events from another WSL transport.
  return (
    expectedConnectionId === null &&
    typeof wslDistro === 'string' &&
    wslDistro.trim().length > 0 &&
    isWslHookRelayConnectionId(entryConnectionId) &&
    entryConnectionId === wslHookRelayConnectionId(wslDistro.trim())
  )
}
