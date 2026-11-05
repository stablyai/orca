import { randomUUID } from 'node:crypto'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/agent-session-caller-env'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

export function createOrchestrationCompatibilityEnvelope(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope {
  const evidence = readOrchestrationCompatibilityEvidence(env)
  // Only local environment session ids can identify a session on this host.
  const agentSessionId = readInjectedAgentSessionId(env)
  return {
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence: agentSessionId ? { ...evidence, agentSessionId } : evidence
  }
}

/** Same-host pane or chat evidence; foreign host homes must not select this host's accounts. */
export function createAgentLaunchCallerEvidence(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope['orchestrationCompatibilityEvidence'] {
  const agentSessionId = readInjectedAgentSessionId(env)
  const evidence = readOrchestrationCompatibilityEvidence(env)
  if (evidence?.host) {
    return undefined
  }
  return agentSessionId ? { ...evidence, agentSessionId } : evidence
}
