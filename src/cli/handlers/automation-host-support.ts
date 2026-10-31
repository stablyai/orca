import {
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY,
  AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import {
  EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED,
  hasExtraAgentArgs
} from '../../shared/automation-extra-agent-args'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'

const SETUP_CHOICE_HOST_UPDATE_REQUIRED =
  "This host's Orca is too old for --setup on automations. Update Orca on that host, or run the command without --setup."

// Older runtimes silently strip these fields and would run without the requested arguments or setup choice.
export async function assertAutomationFieldsSupported(
  client: RuntimeClient,
  fields: { extraAgentArgs?: string; setupDecision?: 'run' | 'skip' }
): Promise<void> {
  const needsExtraAgentArgs = hasExtraAgentArgs(fields.extraAgentArgs)
  if (!needsExtraAgentArgs && fields.setupDecision === undefined) {
    return
  }
  const capabilities = (await client.call<RuntimeStatus>('status.get')).result.capabilities ?? []
  if (
    needsExtraAgentArgs &&
    !capabilities.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError('incompatible_runtime', EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED)
  }
  if (
    fields.setupDecision !== undefined &&
    !capabilities.includes(AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY)
  ) {
    throw new RuntimeClientError('incompatible_runtime', SETUP_CHOICE_HOST_UPDATE_REQUIRED)
  }
}
