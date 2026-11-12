import { agentSessionAdvisoryPolicySchema } from '../../../shared/agent-session/agent-session-advisory-policy'
import { ORCHESTRATION_WORKER_ADVISORY_POLICY_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { readTextOrFileFlag } from '../../command-body-input'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'

export async function readWorkerAdvisoryPolicy(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
) {
  if (!flags.has('advisory-policy-file')) {
    return undefined
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (
    !status.result.capabilities?.includes(ORCHESTRATION_WORKER_ADVISORY_POLICY_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The connected Orca runtime does not understand bounded advisory workers. Update or restart Orca before trying again.'
    )
  }
  const raw = await readTextOrFileFlag(flags, cwd, 'advisory-policy', true)
  try {
    if (!raw || Buffer.byteLength(raw, 'utf8') > 8_388_608) {
      throw new Error('Invalid policy size.')
    }
    return agentSessionAdvisoryPolicySchema.parse(JSON.parse(raw))
  } catch {
    throw new RuntimeClientError('invalid_argument', 'Invalid advisory policy file.')
  }
}
