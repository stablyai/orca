import { randomUUID } from 'node:crypto'
import { readInjectedAgentSessionId } from '../../shared/agent-session-caller-env'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

export function createOrchestrationCompatibilityEnvelope(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope {
  const evidence = readOrchestrationCompatibilityEvidence(env)
  // Read here, from this CLI's own environment only: the SSH paths build evidence from a remote
  // shell's environment, where a session id could never name a session on this host.
  const agentSessionId = readInjectedAgentSessionId(env)
  return {
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence: agentSessionId ? { ...evidence, agentSessionId } : evidence
  }
}
