// Pure projection from redacted admission capacity rows to the client-safe
// pending-summary DTO. Dependency-injected (liveness, deep link, ssh label) and
// electron-free so it is unit-testable; the runtime supplies the host lookups.
// The launch token on each input row stays host-side — it is used only to feed
// the injected liveness resolver and is never copied into an output row.

import { getLocalExecutionHostLabel, parseExecutionHostId } from '../../shared/execution-host'
import type { AgentLaunchExecutionHostId } from '../../shared/agent-launch-host-contract'
import type {
  PendingAgentLaunchDeepLink,
  PendingAgentLaunchLiveness,
  PendingAgentLaunchSummary,
  PendingAgentLaunchSummaryRow
} from '../../shared/agent-launch-pending-summary'
import type { AdmissionCapacityRow } from './agent-launch-admission-store'

/** User-facing display name for a launch's execution host. Composes the shared
 *  local/ssh/runtime labelers with this feature's `wsl:${distro}` arm (the shared
 *  grammar has no WSL variant). Returns a name, never a path. */
export function agentLaunchExecutionHostDisplayName(
  id: AgentLaunchExecutionHostId,
  sshLabelFor: (targetId: string) => string | undefined
): string {
  if (id === 'local') {
    return getLocalExecutionHostLabel()
  }
  if (id.startsWith('wsl:')) {
    try {
      return decodeURIComponent(id.slice('wsl:'.length))
    } catch {
      return id
    }
  }
  const parsed = parseExecutionHostId(id)
  if (parsed?.kind === 'ssh') {
    return sshLabelFor(parsed.targetId) ?? parsed.targetId
  }
  if (parsed?.kind === 'runtime') {
    return parsed.environmentId
  }
  return id
}

export type PendingAgentLaunchSummaryDeps = {
  resolveLiveness: (row: AdmissionCapacityRow) => PendingAgentLaunchLiveness
  resolveDeepLink: (row: AdmissionCapacityRow) => PendingAgentLaunchDeepLink | undefined
  sshLabelFor: (targetId: string) => string | undefined
}

export function buildPendingAgentLaunchSummary(
  rows: readonly AdmissionCapacityRow[],
  deps: PendingAgentLaunchSummaryDeps
): PendingAgentLaunchSummary {
  return {
    rows: rows.map((row): PendingAgentLaunchSummaryRow => {
      const deepLink = deps.resolveDeepLink(row)
      return {
        sourceKind: row.intent,
        baseHarness: row.baseHarness,
        targetHostDisplayName: agentLaunchExecutionHostDisplayName(
          row.executionHostId,
          deps.sshLabelFor
        ),
        admittedAt: row.admittedAt,
        liveness: deps.resolveLiveness(row),
        ...(deepLink ? { deepLink } : {})
      }
    })
  }
}
