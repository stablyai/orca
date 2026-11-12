import { readdir } from 'node:fs/promises'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AgentLaunchModeReceipt } from '../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from './worker-start-schema'

function refuse(): never {
  throw new OrchestrationError(
    'agent_unconfigured',
    'Advisory workers require a supported constrained adapter and an empty local folder workspace. No effects were applied.',
    { effectsApplied: false }
  )
}

export function assertAdvisoryWorkerRequest(params: WorkerStartInput, followUp: boolean) {
  if (params.advisoryPolicy && (followUp || !WorkerStartParams.safeParse(params).success)) {
    refuse()
  }
}

export async function assertAdvisoryWorkerPlacement(
  params: WorkerStartInput,
  workspace: (Pick<Worktree, 'id'> & Partial<Pick<Worktree, 'path' | 'hostId'>>) | undefined,
  mode: AgentLaunchModeReceipt
) {
  if (!params.advisoryPolicy) {
    return
  }
  if (!workspace || !workspace.path) {
    refuse()
  }
  const host = getStructuredAgentSessionHost()
  const now = host?.deps.now?.() ?? Date.now()
  if (
    parseWorkspaceKey(workspace.id)?.type !== 'folder' ||
    workspace.hostId !== 'local' ||
    mode.mode !== 'structured' ||
    params.advisoryPolicy.deadlineAt <= now ||
    params.advisoryPolicy.deadlineAt - now > 300_000 ||
    host?.deps.adapter.supportsAdvisoryPolicy?.(
      {
        executionHostId: 'local',
        workspaceId: workspace.id,
        workspaceKind: 'folder',
        wslDistro: null
      },
      'claude'
    ) !== true
  ) {
    refuse()
  }
  // No ambient project instructions may supplement the admitted snapshot context.
  try {
    if ((await readdir(workspace.path)).length !== 0) {
      refuse()
    }
  } catch {
    refuse()
  }
}
