import { randomUUID } from 'node:crypto'
import { readInjectedAgentSessionId } from '../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { readOrchestrationCompatibilityEvidence } from '../../../shared/orchestration/orchestration-compatibility-evidence'
import { BOT_ITEM_WRITE_METHOD_NAMES } from '../../../shared/bots/bot-items'
import { CONNECTOR_POST_METHOD_NAMES } from '../../../shared/connector-action-contract'
import type { RuntimeOrchestrationEnvelope } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

export function renewCompatibilityInvocation(
  envelope: RuntimeOrchestrationEnvelope,
  requestId?: string
): RuntimeOrchestrationEnvelope {
  return { ...envelope, compatibilityInvocationId: requestId ?? envelope.compatibilityInvocationId }
}

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

/** Methods whose calling agent session the host verifies: a launch, which it records in the caller's
 *  chat (older hosts ignore the evidence), and automation, item and connector post writes, which act
 *  for that session. */
const SESSION_EVIDENCE_METHODS: ReadonlySet<string> = new Set([
  'agent.launch',
  'agent.launchReplay',
  'automation.create',
  'automation.update',
  ...BOT_ITEM_WRITE_METHOD_NAMES,
  ...CONNECTOR_POST_METHOD_NAMES
])

function namesChatCaller(method: string): boolean {
  return SESSION_EVIDENCE_METHODS.has(method) || method.startsWith('browser.')
}

/** The caller evidence one request carries, read from this process's environment once. */
export class OrchestrationRequestEvidence {
  private readonly orchestration: RuntimeOrchestrationEnvelope
  // A chat's session id means nothing on another server, so reads there go like a shell's.
  private readonly remoteRead: RuntimeOrchestrationEnvelope
  private readonly chatCaller: RuntimeOrchestrationEnvelope['orchestrationCompatibilityEvidence']

  constructor(env: NodeJS.ProcessEnv) {
    this.orchestration = createOrchestrationCompatibilityEnvelope(env)
    const { agentSessionId: _session, ...shell } =
      this.orchestration.orchestrationCompatibilityEvidence ?? {}
    this.remoteRead = {
      ...this.orchestration,
      orchestrationCompatibilityEvidence: Object.keys(shell).length > 0 ? shell : undefined
    }
    this.chatCaller = createChatCallerEvidence(env)
  }

  envelopeFor(
    method: string,
    request: { remote: boolean; mutation: boolean; requestId: string | undefined }
  ): RuntimeOrchestrationEnvelope {
    if (
      method.startsWith('orchestration.') ||
      method === 'pipeline.submit' ||
      method === 'pipeline.v2.submit'
    ) {
      const base = request.remote && !request.mutation ? this.remoteRead : this.orchestration
      return {
        ...base,
        compatibilityInvocationId: request.requestId ?? base.compatibilityInvocationId
      }
    }
    // A worker's own terminal or chat names itself, so the terminal it creates closes with it.
    if ((method === 'terminal.create' || method === 'terminal.split') && !request.remote) {
      return {
        orchestrationCompatibilityEvidence: this.orchestration.orchestrationCompatibilityEvidence
      }
    }
    return namesChatCaller(method) && !request.remote && this.chatCaller
      ? { orchestrationCompatibilityEvidence: this.chatCaller }
      : {}
  }
}
