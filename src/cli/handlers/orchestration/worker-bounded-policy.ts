import { agentSessionAdvisoryPolicySchema } from '../../../shared/agent-session/agent-session-advisory-policy'
import { agentSessionExecutionPolicySchema } from '../../../shared/agent-session/agent-session-execution-policy'
import {
  ORCHESTRATION_WORKER_ADVISORY_POLICY_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_EXECUTION_POLICY_RUNTIME_CAPABILITY
} from '../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { readTextOrFileFlag } from '../../command-body-input'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'

export async function readWorkerBoundedPolicies(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
) {
  if (!flags.has('advisory-policy-file') && !flags.has('execution-policy-file')) {
    return {}
  }
  const status = await client.call<RuntimeStatus>('status.get')
  const policies: {
    advisoryPolicy?: ReturnType<typeof agentSessionAdvisoryPolicySchema.parse>
    executionPolicy?: ReturnType<typeof agentSessionExecutionPolicySchema.parse>
  } = {}
  for (const [kind, capability] of [
    ['advisory', ORCHESTRATION_WORKER_ADVISORY_POLICY_RUNTIME_CAPABILITY],
    ['execution', ORCHESTRATION_WORKER_EXECUTION_POLICY_RUNTIME_CAPABILITY]
  ] as const) {
    if (!flags.has(`${kind}-policy-file`)) {
      continue
    }
    if (!status.result.capabilities?.includes(capability)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'Update or restart Orca before using bounded workers.'
      )
    }
    const raw = await readTextOrFileFlag(flags, cwd, `${kind}-policy`, true, 8_388_608)
    try {
      if (!raw || Buffer.byteLength(raw, 'utf8') > 8_388_608) {
        throw new Error('Invalid policy size.')
      }
      if (kind === 'advisory') {
        policies.advisoryPolicy = agentSessionAdvisoryPolicySchema.parse(JSON.parse(raw))
      } else {
        policies.executionPolicy = agentSessionExecutionPolicySchema.parse(JSON.parse(raw))
      }
    } catch {
      throw new RuntimeClientError('invalid_argument', `Invalid ${kind} policy file.`)
    }
  }
  return policies
}
