import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { readTerminalStartFailure } from '../../../../shared/terminal/pty/lifecycle/terminal-start-failure'
import type { RuntimeTerminalWait } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  freshLaunchPtyId,
  getLaunchedAgentReadinessLane,
  waitForWorkerAgentReady,
  type LaunchedAgentReadinessRuntime
} from './launched-agent-composer-readiness'

/** A fresh launch's wait that only ran out while `agent` itself, from that launch, is in front: a slow start, not a failed one.
 *  Marker-only agents never qualify, since a startup dialog only withholds their marker. */
async function isSlowLaunchedAgent(
  runtime: Pick<OrcaRuntimeService, 'isExactAgentInFront'>,
  handle: string,
  agent: TuiAgent,
  args: Parameters<typeof waitForWorkerAgentReady>[2],
  error: unknown
): Promise<boolean> {
  const ptyId = args.reusesTerminal ? null : freshLaunchPtyId(handle, args.creation)
  const incarnationId = args.creation?.incarnationId
  return (
    ptyId !== null &&
    !!incarnationId &&
    error instanceof Error &&
    error.message === 'timeout' &&
    !readTerminalStartFailure(error) &&
    getLaunchedAgentReadinessLane(agent) !== 'composer-marker' &&
    (await runtime.isExactAgentInFront(ptyId, agent, incarnationId))
  )
}

/** The worker's readiness wait; null when only time ran out on an agent proven in front, so its
 *  brief still goes in and an unseen turn alerts once (start_unknown) instead of failing the start. */
export async function waitForWorkerAgentOrSlowStart(
  runtime: LaunchedAgentReadinessRuntime & Pick<OrcaRuntimeService, 'isExactAgentInFront'>,
  handle: string,
  args: Parameters<typeof waitForWorkerAgentReady>[2]
): Promise<RuntimeTerminalWait | null> {
  try {
    return await waitForWorkerAgentReady(runtime, handle, args)
  } catch (error) {
    if (args.agent && (await isSlowLaunchedAgent(runtime, handle, args.agent, args, error))) {
      return null
    }
    throw error
  }
}
