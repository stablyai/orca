import 'node:crypto'
import '../../../shared/orchestration/workers/structured-worker-handle'
import '../../../shared/workspace-layout/stable-pane-id'
import { readWorkerTerminalHostScope } from '../../../shared/orchestration/workers/worker-terminal-host-scope'
import 'zod'
import '../../../shared/agent-session/view/structured-agent-session-projection'
import '../orchestration/addressing/session-lineage/structured-session-lineage'
import '../../../shared/execution-host'
import type { AgentSenderPane } from './agent-sender-live-panes'

export function agentSenderExecutionKey(
  incarnation: string | null,
  value: string | null | undefined
): string | null {
  if (!incarnation) {
    return null
  }
  const read = readWorkerTerminalHostScope(value)
  const scope =
    read.kind === 'absent'
      ? { kind: 'local', hostId: 'local' }
      : read.kind === 'local' || read.kind === 'remote'
        ? read.scope
        : null
  return scope ? JSON.stringify([incarnation, scope]) : null
}

export function agentSenderPaneFacts(pane: AgentSenderPane): string {
  return JSON.stringify([
    pane.handle,
    pane.processIncarnation,
    pane.hostScope,
    pane.launchTokenHash
  ])
}
