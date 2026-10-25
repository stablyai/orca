import { refuse } from '../../../shared/agent-session-wire'
import type { HostFoundingAttempt } from '../../agent-launch/host-founding-attempt'

import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'

import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { reserveRequestFor, type AgentSessionAttachParams } from './structured-agent-session-attach'

import {
  pinnedAgentSessionLaunchArgs,
  pinnedAgentSessionLaunchEnv
} from './structured-agent-session-launch-env'

export type StructuredAgentSessionCreateOptions = {
  firstMessage?: { clientMessageId: string; body: AgentJournalMessageItem }
  /** Host launches keep a usable blank chat on proven message noncommit; clients stay strict. */
  hostFoundingAttempt?: HostFoundingAttempt
  hostLaunchDirectory?: string
  /** The saved list the chat's options are admitted against, for the folder its picker read. */
  catalogModels?: Parameters<typeof reserveRequestFor>[0]['models']
  /** Called after the durable create, before delivery can start the agent. */
  publishTab?: () => Promise<void>
}

export function unknownFoundingOutcome() {
  return refuse(
    'agent_session_operation_unknown',
    { reason: 'outcomeUnknown' },
    'The create outcome is unknown.'
  )
}

export async function prepareFoundingRequest(
  context: StructuredAgentSessionAttachContext,
  callerKey: string,
  params: AgentSessionAttachParams,
  options: StructuredAgentSessionCreateOptions,
  prior: ReturnType<StructuredAgentSessionAttachContext['deps']['store']['getRecord']>
) {
  const { deps } = context
  const sessionId = params.envelope.sessionId
  const launchDirectory =
    !prior && isFloatingWorkspaceId(params.location.workspaceId)
      ? (options.hostLaunchDirectory ??
        (await deps.resolveWorkspacePath?.(params.location.workspaceId)))
      : undefined
  if (!prior && isFloatingWorkspaceId(params.location.workspaceId) && !launchDirectory) {
    throw new Error('floating_agent_session_launch_directory_unavailable')
  }
  return reserveRequestFor({
    sessionId,
    params,
    models: prior ? undefined : options.catalogModels,
    callerKey,
    fingerprint: params.envelope.payloadFingerprint,
    now: context.now(),
    authority: {
      ...(launchDirectory ? { launchDirectory } : {}),
      spawnToken: () => {
        throw new Error('founding_must_not_reserve_a_spawn')
      },
      claimKeyId: deps.claimKeyId,
      handoffOperationId: null,
      probe: { outcome: 'pid-absent' },
      ...(await pinnedAgentSessionLaunchArgs(deps.resolveLaunchArgs, params)),
      ...(await pinnedAgentSessionLaunchEnv(deps.resolveLaunchEnv, params))
    }
  })
}
