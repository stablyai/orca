import type { RuntimeTerminalState, RuntimeTerminalWait } from '../../../../shared/runtime-types'
import type { OrcaRuntimeService } from '../../orca-runtime'

/** Marks a readiness failure whose launched agent is still running, so the
 *  start receipt reports an unknown outcome instead of a failed launch. */
export const AGENT_READINESS_OUTCOME_UNKNOWN_CODE = 'agent_readiness_outcome_unknown'

type ReadinessRuntime = Pick<OrcaRuntimeService, 'waitForTerminal' | 'showTerminal'>

export type AgentReadinessObservation = {
  wait: RuntimeTerminalWait
  /** The wait ran out of time instead of observing the pane settle, so it holds no verdict. */
  timedOut: boolean
  timeoutMs: number
}

export async function observeAgentReadiness(args: {
  runtime: ReadinessRuntime
  terminalHandle: string
  timeoutMs: number
}): Promise<AgentReadinessObservation> {
  try {
    const wait = await args.runtime.waitForTerminal(args.terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: args.timeoutMs
    })
    return { wait, timedOut: false, timeoutMs: args.timeoutMs }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'timeout') {
      throw error
    }
    // Why: a readiness timeout is the absence of a verdict; probe the pane so a
    // still-running agent is not reported as a launch that never happened.
    return {
      wait: {
        handle: args.terminalHandle,
        condition: 'tui-idle',
        satisfied: false,
        status: await readAgentTerminalState(args.runtime, args.terminalHandle),
        exitCode: null
      },
      timedOut: true,
      timeoutMs: args.timeoutMs
    }
  }
}

export function agentReadinessFailure(observation: AgentReadinessObservation): Error {
  const { wait } = observation
  if (wait.blockedReason) {
    return new Error(`Agent startup blocked: ${wait.blockedReason}`)
  }
  if (!observation.timedOut) {
    return new Error(`Agent did not become ready (${wait.status}).`)
  }
  const error = new Error(
    `Agent readiness timed out after ${observation.timeoutMs}ms (terminal ${wait.status}).`
  )
  return wait.status === 'running'
    ? Object.assign(error, { code: AGENT_READINESS_OUTCOME_UNKNOWN_CODE })
    : error
}

async function readAgentTerminalState(
  runtime: ReadinessRuntime,
  handle: string
): Promise<RuntimeTerminalState> {
  try {
    const terminal = await runtime.showTerminal(handle)
    if (terminal.connected === true) {
      return 'running'
    }
    return terminal.connected === false ? 'exited' : 'unknown'
  } catch {
    // Why: a handle that can no longer be shown is not evidence of a live agent.
    return 'unknown'
  }
}
