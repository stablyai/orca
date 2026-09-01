// Builders for the versioned agent-reference snapshot and its 512 KiB
// remote-projection budget, shared by the service's read paths and the
// mutateReferences post-mutation budget check.

import type { GlobalSettings } from '../../shared/types'
import type { AgentReferenceSnapshot } from '../../shared/agent-reference-snapshot'
import { utf8ByteLength } from '../../shared/custom-tui-agents'

export const AGENT_REFERENCE_PROJECTION_MAX_BYTES = 524_288

export function buildAgentReferenceSnapshot(settings: GlobalSettings): AgentReferenceSnapshot {
  return {
    version: 1,
    revision: settings.agentReferenceRevision ?? 1,
    terminalQuickCommands: settings.terminalQuickCommands ?? [],
    ...(settings.commitMessageAi ? { commitMessageAi: settings.commitMessageAi } : {}),
    ...(settings.sourceControlAi ? { sourceControlAi: settings.sourceControlAi } : {})
  }
}

export function measureAgentReferenceProjection(settings: GlobalSettings): {
  bytes: number
  tooLarge: boolean
} {
  const bytes = utf8ByteLength(JSON.stringify(buildAgentReferenceSnapshot(settings)))
  return { bytes, tooLarge: bytes > AGENT_REFERENCE_PROJECTION_MAX_BYTES }
}
