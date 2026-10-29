import { randomUUID } from 'node:crypto'
import {
  ORCA_AGENT_SESSION_PROOF_ENV,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV,
  readInjectedAgentSessionId
} from '../../shared/agent-session-caller-env'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

export function createOrchestrationCompatibilityEnvelope(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope {
  const evidence = readOrchestrationCompatibilityEvidence(env)
  // Only local environment session ids can identify a session on this host.
  const agentSessionId = readInjectedAgentSessionId(env)
  const agentSessionSpawnToken =
    env[ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV]?.trim() || env[ORCA_AGENT_SESSION_PROOF_ENV]?.trim()
  return {
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence: agentSessionId
      ? {
          ...evidence,
          agentSessionId,
          ...(agentSessionSpawnToken ? { agentSessionSpawnToken } : {})
        }
      : evidence
  }
}

export function localJobEvidence(
  envelope: RuntimeOrchestrationEnvelope,
  remote: boolean
): RuntimeOrchestrationEnvelope {
  return remote
    ? {}
    : { orchestrationCompatibilityEvidence: envelope.orchestrationCompatibilityEvidence }
}
