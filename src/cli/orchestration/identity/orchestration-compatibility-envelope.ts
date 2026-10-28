import { randomUUID } from 'node:crypto'
import {
  ORCA_AGENT_SESSION_PROOF_ENV,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV,
  readInjectedAgentSessionId
} from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { readOrchestrationCompatibilityEvidence } from '../../../shared/orchestration/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

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

/** The chat a launch or browser command came from, so the host can show its agent or page there.
 *  Only a same-host session can be named: host-stamped (WSL) environments send nothing. */
export function createChatCallerEvidence(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope['orchestrationCompatibilityEvidence'] {
  const agentSessionId = readInjectedAgentSessionId(env)
  if (!agentSessionId || readOrchestrationCompatibilityEvidence(env)?.host) {
    return undefined
  }
  return { agentSessionId }
}

/** The caller evidence one request carries, read from this process's environment once. */
export class OrchestrationRequestEvidence {
  private readonly orchestration: RuntimeOrchestrationEnvelope
  // A chat's session id means nothing on another server, so reads there go like a shell's.
  private readonly remoteRead: RuntimeOrchestrationEnvelope

  constructor(env: NodeJS.ProcessEnv) {
    this.orchestration = createOrchestrationCompatibilityEnvelope(env)
    const {
      agentSessionId: _session,
      agentSessionSpawnToken: _proof,
      ...shell
    } = this.orchestration.orchestrationCompatibilityEvidence ?? {}
    this.remoteRead = {
      ...this.orchestration,
      orchestrationCompatibilityEvidence: Object.keys(shell).length > 0 ? shell : undefined
    }
  }

  envelopeFor(
    method: string,
    request: { remote: boolean; mutation: boolean; requestId: string | undefined }
  ): RuntimeOrchestrationEnvelope {
    if (method.startsWith('orchestration.')) {
      const base = request.remote && !request.mutation ? this.remoteRead : this.orchestration
      return {
        ...base,
        compatibilityInvocationId: request.requestId ?? base.compatibilityInvocationId
      }
    }
    return request.remote
      ? {}
      : {
          orchestrationCompatibilityEvidence: this.orchestration.orchestrationCompatibilityEvidence
        }
  }
}
