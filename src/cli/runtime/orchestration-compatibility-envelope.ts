import { randomUUID } from 'node:crypto'
import { readOrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'

export function createOrchestrationCompatibilityEnvelope(
  env: NodeJS.ProcessEnv
): RuntimeOrchestrationEnvelope {
  return {
    compatibilityInvocationId: randomUUID(),
    orchestrationCompatibilityEvidence: readOrchestrationCompatibilityEvidence(env)
  }
}
