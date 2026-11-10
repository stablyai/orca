import { randomUUID } from 'node:crypto'
import { readInjectedAgentSessionId } from '../../shared/agent-session/lifecycle/agent-session-caller-env'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration/orchestration-compatibility-evidence'
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

/** The chat an agent launch came from, so the host can show the launched agent there.
 *  Only a same-host session can be named: host-stamped (WSL) environments send nothing. */
export function createAgentLaunchCallerEvidence(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope['orchestrationCompatibilityEvidence'] {
  const agentSessionId = readInjectedAgentSessionId(env)
  if (!agentSessionId || readOrchestrationCompatibilityEvidence(env)?.host) {
    return undefined
  }
  return { agentSessionId }
}

const AGENT_LAUNCH_METHODS: ReadonlySet<string> = new Set(['agent.launch', 'agent.launchReplay'])

/** The caller evidence one request carries, read from this process's environment once. */
export class OrchestrationRequestEvidence {
  private readonly orchestration: RuntimeOrchestrationEnvelope
  // A chat's session id means nothing on another server, so reads there go like a shell's.
  private readonly remoteRead: RuntimeOrchestrationEnvelope
  private readonly agentLaunchCaller: RuntimeOrchestrationEnvelope['orchestrationCompatibilityEvidence']

  constructor(env: NodeJS.ProcessEnv) {
    this.orchestration = createOrchestrationCompatibilityEnvelope(env)
    const { agentSessionId: _session, ...shell } =
      this.orchestration.orchestrationCompatibilityEvidence ?? {}
    this.remoteRead = {
      ...this.orchestration,
      orchestrationCompatibilityEvidence: Object.keys(shell).length > 0 ? shell : undefined
    }
    this.agentLaunchCaller = createAgentLaunchCallerEvidence(env)
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
    return AGENT_LAUNCH_METHODS.has(method) && !request.remote && this.agentLaunchCaller
      ? { orchestrationCompatibilityEvidence: this.agentLaunchCaller }
      : {}
  }
}
