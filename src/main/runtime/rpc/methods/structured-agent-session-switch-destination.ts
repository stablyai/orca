import type { RpcContext } from '../core'
import type { AgentSessionSwitchDeadline } from '../../../../shared/agent-session-switch-execution'
import { AgentSessionRefusalError } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { structuredCallerFor } from './structured-agent-session-gate'
import {
  prepareStructuredAgentSessionCreateForWorktree,
  commitStructuredAgentSessionCreate
} from './structured-agent-session-create'
import { resolveStructuredSwitchRetainedOwner } from './structured-agent-session-switch-source'
import type { PreparedSwitch } from './structured-agent-session-switch-execution'

type SwitchStop = Parameters<typeof commitStructuredAgentSessionCreate>[0]['switchStop']

/**
 * A switch's new chat, created at rest with no tab once its source stopped; a create that fails
 * after its owner exists keeps that owner. Answers the chat's session id.
 */
export async function createSwitchDestination(
  ctx: RpcContext,
  prepared: PreparedSwitch,
  deadline: AgentSessionSwitchDeadline,
  source: { stopped: SwitchStop; capturedSource: boolean }
): Promise<string> {
  const { host, create, sourceEvidence, createIdentity, providerSessionId } = prepared
  const adopt = createIdentity?.adopt
  const { stopped } = source
  deadline.check()
  try {
    const preparedCreate = await prepareStructuredAgentSessionCreateForWorktree({
      ...create!,
      runtime: ctx.runtime,
      caller: structuredCallerFor(ctx),
      atRest: true,
      ensureHost: async () => host,
      structuredAgentCliSourceEvidence: sourceEvidence,
      // Only a stopped, captured source is the switched tab; a pane it could not capture (and a
      // History open) keeps main's writer check, since nothing proved its CLI stopped.
      switchedTabOnly: source.capturedSource,
      // After a stop, the transcript read before it: the stop's record founds even if it moved.
      pinnedAdoption:
        adopt?.transcriptPath && stopped
          ? { accountHome: createIdentity!.accountHome, transcriptPath: adopt.transcriptPath }
          : undefined
    })
    deadline.check()
    const created = await commitStructuredAgentSessionCreate({
      runtime: ctx.runtime,
      caller: structuredCallerFor(ctx),
      prepared: { ...preparedCreate, tab: null },
      activate: false,
      check: deadline.check,
      ...(adopt && stopped ? { switchStop: stopped } : {})
    })
    if (!created.ok) {
      throw new AgentSessionRefusalError(created.refusal)
    }
    return created.value.sessionId
  } catch (error) {
    return resolveStructuredSwitchRetainedOwner(error, host, createIdentity, providerSessionId)
  }
}
