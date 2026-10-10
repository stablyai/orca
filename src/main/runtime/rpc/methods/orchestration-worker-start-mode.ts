/**
 * `orchestration.workerStart`'s view of the shared launch-mode decision.
 *
 * The decision itself lives in `main/agent-launch/agent-launch-mode`, which every launch surface
 * shares — a worker is not a special kind of launch, it is the same launch with a dispatch
 * attached. All this module contributes is the noun orchestration puts in its receipts ("worker")
 * and the `--terminal` wording, so a dispatch receipt reads the way it always has.
 */

import {
  decideAgentLaunchMode,
  downgradeAgentLaunchModeForHost,
  readAgentLaunchModeSettings,
  resolveAgentLaunchModeOnHost,
  type AgentLaunchMode,
  type AgentLaunchModeReason,
  type AgentLaunchModeReceipt,
  type AgentLaunchModeSettings,
  type AgentLaunchModeVocabulary
} from '../../../agent-launch/agent-launch-mode'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'

export type WorkerStartMode = AgentLaunchMode
export type WorkerStartModeReason = AgentLaunchModeReason
export type WorkerStartModeReceipt = AgentLaunchModeReceipt

/** Orchestration's receipts are read next to dispatch records, so they name the worker and the
 *  flag that reused a terminal. Pinned here because the exact strings are asserted. */
export const WORKER_START_VOCABULARY: AgentLaunchModeVocabulary = {
  structured: 'a structured chat session worker',
  terminal: 'a terminal agent worker',
  detailOverrides: {
    remote_execution_host: 'this worker runs on a remote execution host',
    reused_terminal: '--terminal reuses a running terminal agent'
  }
}

/** The placement options that exist only on `worker-start`. `worktree`, `model` and `effort` are
 *  listed but no longer read: a structured worker honours all three, and naming them here keeps
 *  the set of options this decision has considered visible. */
type WorkerStartModePlacement = {
  agent?: string
  on?: string
  terminal?: string
  worktree?: string
  model?: string
  effort?: string
}

export function decideWorkerStartMode(args: {
  params: WorkerStartModePlacement
  settings: AgentLaunchModeSettings | null | undefined
}): WorkerStartModeReceipt {
  return decideAgentLaunchMode({
    placement: args.params,
    settings: args.settings,
    vocabulary: WORKER_START_VOCABULARY
  })
}

export async function resolveWorkerStartModeOnHost(
  runtime: Pick<OrcaRuntimeService, 'getStructuredAgentSessionCreateSupport'>,
  mode: WorkerStartModeReceipt,
  worktreeId: string | undefined,
  agent: TuiAgent | undefined
): Promise<WorkerStartModeReceipt> {
  return resolveAgentLaunchModeOnHost(runtime, mode, worktreeId, agent, WORKER_START_VOCABULARY)
}

export function downgradeWorkerStartModeForHost(
  receipt: WorkerStartModeReceipt,
  support: { supported: boolean; reason?: 'agent' | 'remote' | 'wsl' } | null
): WorkerStartModeReceipt {
  return downgradeAgentLaunchModeForHost(receipt, support, WORKER_START_VOCABULARY)
}

export function readWorkerStartModeSettings(
  runtime: Pick<OrcaRuntimeService, 'getClientSettings'>
): AgentLaunchModeSettings | null {
  return readAgentLaunchModeSettings(runtime)
}
