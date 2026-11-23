import {
  AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY,
  AUTOMATION_SCHEDULE_RULES_RUNTIME_CAPABILITY,
  AUTOMATION_SCHEDULE_RULES_UPDATE_REQUIRED_MESSAGE,
  AUTOMATION_SETUP_CHOICE_RUNTIME_CAPABILITY
} from '../../shared/automations/automation-runtime-capabilities'
import { needsScheduleRulesCapability } from '../../shared/automations/scheduling/automation-schedule-occurrences'
import {
  EXTRA_AGENT_ARGS_HOST_UPDATE_REQUIRED,
  hasExtraAgentArgs
} from '../../shared/agent-launch/startup/automation-extra-agent-args'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/connection/types'

const SETUP_CHOICE_HOST_UPDATE_REQUIRED =
  "This host's Orca is too old for --setup on automations. Update Orca on that host, or run the command without --setup."

// Older runtimes silently strip these fields and would run without the requested arguments or setup choice.
export async function assertAutomationFieldsSupported(
  client: RuntimeClient,
  fields: { extraAgentArgs?: string; setupDecision?: 'run' | 'skip'; rrule?: string }
): Promise<void> {
  const needsExtraAgentArgs = hasExtraAgentArgs(fields.extraAgentArgs)
  // The local runtime ships with this CLI, so only a remote host can be too old for the rule.
  const needsScheduleRules =
    client.isRemote && fields.rrule !== undefined && needsScheduleRulesCapability(fields.rrule)
  if (!needsExtraAgentArgs && fields.setupDecision === undefined && !needsScheduleRules) {
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
  if (needsScheduleRules && !capabilities.includes(AUTOMATION_SCHEDULE_RULES_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      AUTOMATION_SCHEDULE_RULES_UPDATE_REQUIRED_MESSAGE
    )
  }
}
