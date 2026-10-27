/** Reuse shared agent-launch-mode; orchestration contributes only worker/--terminal vocabulary for its established receipts. */

import {
  decideAgentLaunchMode,
  downgradeAgentLaunchModeForHost,
  readAgentLaunchModeSettings,
  resolveAgentLaunchModeOnHost,
  type AgentLaunchModeReceipt,
  type AgentLaunchModeSettings,
  type AgentLaunchModeVocabulary
} from '../../../agent-launch/agent-launch-mode'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'

export type WorkerStartModeReceipt = AgentLaunchModeReceipt

/** Keep orchestration's exact worker/reused-terminal wording; receipts are read beside dispatch records. */
export const WORKER_START_VOCABULARY: AgentLaunchModeVocabulary = {
  structured: 'a structured chat session worker',
  terminal: 'a terminal agent worker',
  detailOverrides: {
    remote_execution_host: 'this worker runs on a remote execution host',
    reused_terminal: '--terminal reuses a running terminal agent'
  }
}

/** Keep worktree/model/effort visible as considered inputs even though they no longer force terminal mode. */
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
  runtime: Parameters<typeof readAgentLaunchModeSettings>[0]
): AgentLaunchModeSettings | null {
  return readAgentLaunchModeSettings(runtime)
}
