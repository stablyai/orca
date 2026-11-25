import type { TuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { AgentLaunchModeReceipt as WorkerStartModeReceipt } from '../../../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import { OrchestrationError } from '../../../../../../orchestration/orchestration-error'
import {
  THIS_COMPUTER,
  workerAgentNotInstalledMessage
} from '../../../../../../orchestration/workers/launch/worker-agent-computer-words'
import { resolveWorkerStartModeOnHost } from '../../../structured-workers/orchestration-worker-start-mode'

export const WORKER_AGENT_UNAVAILABLE = 'worker_agent_unavailable'

/** A paired server's not-installed refusal, naming the server as this Orca calls it. */
export function nameRefusingComputer(error: unknown, computer: string): unknown {
  const data =
    error instanceof OrchestrationError &&
    error.code === WORKER_AGENT_UNAVAILABLE &&
    typeof error.data === 'object' &&
    error.data !== null
      ? error.data
      : null
  const agent = data && 'agent' in data ? data.agent : undefined
  return data && 'reason' in data && data.reason === 'not_installed' && isTuiAgent(agent)
    ? new OrchestrationError(
        WORKER_AGENT_UNAVAILABLE,
        workerAgentNotInstalledMessage(agent, computer),
        data
      )
    : error
}

type PreflightRuntime = Pick<
  OrcaRuntimeService,
  | 'getStructuredAgentSessionCreateSupport'
  | 'detectProjectLaunchContext'
  | 'resolveRepoMainWorktreeId'
  | 'showManagedWorktree'
>

/** A checkout Orca knows, never a guess: unknown support would turn a chat into a terminal. */
async function repoCheckoutStandIn(
  runtime: PreflightRuntime,
  repoSelector: string
): Promise<string | undefined> {
  try {
    const id = await runtime.resolveRepoMainWorktreeId(repoSelector)
    return (await runtime.showManagedWorktree(`id:${id}`)).id
  } catch {
    return undefined
  }
}

/**
 * Settle the worker's mode, and that its agent can run, on the computer that runs it, before any
 * workspace exists. A new workspace is checked through its repo's own checkout on the same host;
 * the created workspace is checked again once it exists.
 */
export async function preflightWorkerAgentOnHost(args: {
  runtime: PreflightRuntime
  mode: WorkerStartModeReceipt
  agent: TuiAgent | undefined
  resolvedWorktree?: { id: string; repoId: string }
  creationTarget?: { repoSelector: string }
  /** `--terminal` hands the task to an agent already running there. */
  terminal?: string
}): Promise<WorkerStartModeReceipt> {
  const { runtime, agent, creationTarget } = args
  const hostWorktreeId =
    args.resolvedWorktree?.id ??
    (creationTarget ? await repoCheckoutStandIn(runtime, creationTarget.repoSelector) : undefined)
  // The chat check owns "installed and new enough" for chats; a too-old CLI falls back or refuses there.
  const mode = await resolveWorkerStartModeOnHost(runtime, args.mode, hostWorktreeId, agent)
  const repoSelector = creationTarget?.repoSelector ?? args.resolvedWorktree?.repoId
  if (mode.mode === 'structured' || !agent || args.terminal || !repoSelector) {
    return mode
  }
  // An unreadable host (an unserved SSH target, a folder without one repo) is left to the launch.
  const installed = await runtime
    .detectProjectLaunchContext(repoSelector)
    .then((context): readonly string[] => context.agents)
    .catch(() => null)
  if (installed && !installed.includes(agent)) {
    throw new OrchestrationError(
      WORKER_AGENT_UNAVAILABLE,
      workerAgentNotInstalledMessage(agent, THIS_COMPUTER),
      { effectsApplied: false, agent, reason: 'not_installed' }
    )
  }
  return mode
}
