import { readdir } from 'node:fs/promises'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AgentLaunchModeReceipt } from '../../../../../../shared/agent-launch/contracts/agent-launch-intent'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { WorkerStartInput } from './start/worker-start-input'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'

function refuse(): never {
  throw new OrchestrationError(
    'agent_unconfigured',
    'Bounded workers require a supported constrained adapter and an exact local folder workspace. Advisors require an empty folder. No effects were applied.',
    { effectsApplied: false }
  )
}

export function assertBoundedWorkerRequest(
  params: WorkerStartInput,
  followUp: boolean,
  db: OrchestrationDb
) {
  if (
    (params.advisoryPolicy || params.executionPolicy) &&
    (followUp ||
      !WorkerStartParams.safeParse(params).success ||
      (params.executionPolicy && params.task && db.getDispatchContext(params.task)))
  ) {
    refuse()
  }
}

export async function assertBoundedWorkerPlacement(
  params: WorkerStartInput,
  workspace: (Pick<Worktree, 'id'> & Partial<Pick<Worktree, 'path' | 'hostId'>>) | undefined,
  mode: AgentLaunchModeReceipt,
  runtime: Pick<OrcaRuntimeService, 'ensureStructuredAgentSessionHost'>
) {
  const policy = params.advisoryPolicy ?? params.executionPolicy
  if (!policy) {
    return
  }
  if (!workspace || !workspace.path) {
    refuse()
  }
  try {
    await runtime.ensureStructuredAgentSessionHost()
  } catch {
    refuse()
  }
  const host = getStructuredAgentSessionHost()
  const now = host?.deps.now?.() ?? Date.now()
  if (
    parseWorkspaceKey(workspace.id)?.type !== 'folder' ||
    workspace.hostId !== 'local' ||
    mode.mode !== 'structured' ||
    policy.deadlineAt <= now ||
    policy.deadlineAt - now > 300_000 ||
    (params.executionPolicy
      ? host?.deps.adapter.supportsExecutionPolicy
      : host?.deps.adapter.supportsAdvisoryPolicy
    )?.call(
      host?.deps.adapter,
      {
        executionHostId: 'local',
        workspaceId: workspace.id,
        workspaceKind: 'folder',
        wslDistro: null
      },
      params.executionPolicy ? 'codex' : 'claude'
    ) !== true
  ) {
    refuse()
  }
  if (!params.advisoryPolicy) {
    return
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
