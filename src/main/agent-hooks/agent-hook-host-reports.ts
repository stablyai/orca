// Why (#8711): one place assembles "which hosts did Orca check, and what did
// each one say", so the CLI, the runtime RPC, and any future surface cannot
// drift back into reporting the local machine as if it spoke for every host.

import {
  summarizeAgentHookHostState,
  type AgentHookHostReport
} from '../../shared/agent-hook-host-status'
import { getManagedAgentHookStatuses } from './managed-agent-hook-controls'

export function getLocalAgentHookHostReport(): AgentHookHostReport {
  const statuses = getManagedAgentHookStatuses()
  return {
    host: { kind: 'local' },
    state: summarizeAgentHookHostState(statuses),
    detail: null,
    statuses
  }
}

export function getAgentHookHostReports(
  listSshReports: () => AgentHookHostReport[]
): AgentHookHostReport[] {
  let sshReports: AgentHookHostReport[]
  try {
    sshReports = listSshReports()
  } catch {
    // Why: an unavailable SSH layer must not silently shrink the report to the
    // local host — that is the exact shape of the lie this fixes.
    sshReports = []
  }
  return [getLocalAgentHookHostReport(), ...sshReports]
}
