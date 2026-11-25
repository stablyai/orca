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
  'getStructuredAgentSessionCreateSupport' | 'detectProjectLaunchContext'
>

/**
 * Settle the worker's mode, and that its agent can run, on the computer that runs it, before any
 * workspace exists. A new workspace is checked through the repo it will be created in, which runs
 * where the workspace will; the created workspace is checked again once it exists.
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
  const place = args.resolvedWorktree ? { worktreeId: args.resolvedWorktree.id } : creationTarget
  // The chat check adds "new enough" for chats; a too-old CLI falls back or refuses there.
  const mode = await resolveWorkerStartModeOnHost(runtime, args.mode, place, agent)
  const repoSelector = creationTarget?.repoSelector ?? args.resolvedWorktree?.repoId
  // Installed is checked for every mode: a chat check alone never proves the CLI is there.
  await refuseUninstalledWorkerAgent(runtime, { agent, repoSelector, terminal: args.terminal })
  return mode
}

/** Every worker start's installed-agent check, before any workspace, terminal or Dispatch exists. An
 *  unreadable host (an unserved SSH target, a folder without one repo) is left to the launch. */
export async function refuseUninstalledWorkerAgent(
  runtime: Pick<OrcaRuntimeService, 'detectProjectLaunchContext'>,
  target: { agent: TuiAgent | undefined; repoSelector: string | undefined; terminal?: string }
): Promise<void> {
  const { agent, repoSelector } = target
  if (!agent || target.terminal || !repoSelector) {
    return
  }
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
}
