import { refuseDisabledAgentLaunch } from '../../shared/agent-disabled-launch-refusal'
import type { TuiAgent } from '../../shared/tui-agent'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'

/** Throws `AgentDisabledLaunchError` for an agent the user turned off. Unreadable settings refuse
 *  nothing here; the launch then fails on its own missing store. */
export function refuseDisabledAgentForRuntime(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>,
  agent: TuiAgent
): void {
  let disabled: Iterable<unknown> | undefined
  try {
    disabled = runtime.getClientSettings().disabledTuiAgents
  } catch {
    return
  }
  refuseDisabledAgentLaunch(agent, disabled)
}
