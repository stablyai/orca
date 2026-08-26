import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { markInteractiveZcodeUnavailable } from '../../../zcode/interactive-client'

export async function waitForZcodeReadiness(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  agent: TuiAgent
  promptDelivery: 'agent-input' | 'startup-command'
  timeoutMs: number
}): Promise<void> {
  if (args.agent !== 'zcode' || args.promptDelivery !== 'agent-input') {
    return
  }
  if (
    !(await args.runtime.waitForTerminalAgentProcess(
      args.terminalHandle,
      args.agent,
      args.timeoutMs
    ))
  ) {
    throw new Error(`${args.agent} process did not become ready.`)
  }
  if (!(await args.runtime.waitForTerminalAgentInputReady(args.terminalHandle, args.agent))) {
    throw new Error('zcode TUI did not report an input-ready composer.')
  }
}

export async function zcodeProviderSessionWarning(args: {
  runtime: OrcaRuntimeService
  terminalHandle: string
  agent: TuiAgent
  promptDelivery: 'agent-input' | 'startup-command'
  observedAfter: number
  timeoutMs: number
}): Promise<string | undefined> {
  if (args.agent !== 'zcode' || args.promptDelivery !== 'agent-input') {
    return undefined
  }
  const reported = await args.runtime.waitForTerminalProviderSession(
    args.terminalHandle,
    args.agent,
    args.observedAfter,
    Math.min(args.timeoutMs, 10_000)
  )
  return reported
    ? undefined
    : 'ZCode accepted the dispatch, but its provider session was not reported; output may temporarily fall back to the terminal.'
}

export function recordZcodeReadinessFailure(args: {
  agent: TuiAgent | null | undefined
  promptDelivery: 'agent-input' | 'startup-command'
  failedStage: string
}): void {
  if (
    args.agent === 'zcode' &&
    args.promptDelivery === 'agent-input' &&
    args.failedStage === 'agent_readiness'
  ) {
    markInteractiveZcodeUnavailable()
  }
}

export function mergeWorkerWarning(
  current: string | undefined,
  next: string | undefined
): string | undefined {
  if (!next) {
    return current
  }
  return current ? `${current} ${next}` : next
}

export async function mergeZcodeProviderWarning(
  current: string | undefined,
  args: Parameters<typeof zcodeProviderSessionWarning>[0]
): Promise<string | undefined> {
  return mergeWorkerWarning(current, await zcodeProviderSessionWarning(args))
}
