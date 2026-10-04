import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { OrcaRuntimeService } from './orca-runtime'

export type LaunchedAgentReadinessLane = 'composer-marker' | 'tui-idle'

export type LaunchedAgentReadinessRuntime = Pick<
  OrcaRuntimeService,
  'waitForTerminal' | 'waitForFreshWorkerComposer'
>

export function getLaunchedAgentReadinessLane(agent: TuiAgent): LaunchedAgentReadinessLane {
  return TUI_AGENT_CONFIG[agent].composerReadyCaptures?.length ? 'composer-marker' : 'tui-idle'
}

export function waitForLaunchedAgentComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  timeoutMs: number
): Promise<RuntimeTerminalWait> {
  return getLaunchedAgentReadinessLane(agent) === 'composer-marker'
    ? runtime.waitForFreshWorkerComposer(handle, agent, timeoutMs)
    : runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs })
}

export function waitForWorkerAgentReady(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  args: { agent: TuiAgent | undefined; reusesTerminal: boolean; timeoutMs: number }
): Promise<RuntimeTerminalWait> {
  // A caller-supplied terminal was not freshly launched, so its composer marker may be long gone.
  return args.agent && !args.reusesTerminal
    ? waitForLaunchedAgentComposer(runtime, handle, args.agent, args.timeoutMs)
    : runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: args.timeoutMs })
}
