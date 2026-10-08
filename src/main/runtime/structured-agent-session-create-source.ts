import {
  isLegacyAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../shared/agent-session-account-home'
import type { AgentSessionForkOrigin } from '../../shared/agent-session-fork-origin'
import { isAgentSessionHandleProvider } from '../../shared/agent-session-provider-handle'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionForkSource } from '../../shared/structured-agent-session-create'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { resolveStructuredAgentSessionAdoptionForCreate } from './structured-agent-session-create-adoption'
import { resolveStructuredAgentSessionForkForCreate } from './structured-agent-session-create-fork'

/** Where a new chat's conversation lives, and the one it continues when it does not start fresh. */
export type ResolvedStructuredAgentSessionCreateSource = {
  accountHome: AgentSessionAccountHome
  /** The selection the continued chat already had, ahead of the saved default. */
  options?: Readonly<Record<string, string>>
  /** A floating parent's pinned folder: Claude resumes the copy only from where its source ran. */
  launchDirectory?: string
  forkedFrom?: AgentSessionForkOrigin
  /** The provider conversation the new record adopts. A fork has none yet: its provider copies
   *  when the new chat first starts, from the origin on its record. */
  adopted?: { providerSessionId: string; transcriptPath: string }
}

export async function resolveStructuredAgentSessionCreateSource(input: {
  host: StructuredAgentSessionHost | null
  settings: Parameters<typeof resolveStructuredAgentSessionAdoptionForCreate>[0]['settings']
  agent: string
  selfSessionId: string
  location: AgentSessionExecutionLocation
  resumeFrom?: { providerSessionId: string }
  forkFrom?: StructuredAgentSessionForkSource
  /** The account a fresh create would pin; a fork never asks, since it lives in its parent's. */
  selectAccountHome: () => AgentSessionAccountHome | Promise<AgentSessionAccountHome>
}): Promise<ResolvedStructuredAgentSessionCreateSource> {
  const { host, agent, forkFrom, resumeFrom, selfSessionId } = input
  const unsupported = () =>
    agentSessionRefusalError('structured_agent_session_unsupported', { reason: 'hostUnsupported' })
  if (forkFrom) {
    // Cut from a chat this host holds, by an agent whose provider can copy one.
    if (!host || !isAgentSessionHandleProvider(agent)) {
      throw unsupported()
    }
    return resolveStructuredAgentSessionForkForCreate({
      host,
      agent,
      forkFrom,
      selfSessionId,
      location: input.location
    })
  }
  if (!resumeFrom) {
    return { accountHome: await input.selectAccountHome() }
  }
  // Only Claude and Codex have a transcript to adopt.
  if (!isAgentSessionHandleProvider(agent)) {
    throw unsupported()
  }
  const selected = await input.selectAccountHome()
  // A transcript is found under a config directory; an account of another kind holds none.
  if (!isLegacyAgentSessionAccountHome(selected)) {
    throw unsupported()
  }
  // Adopting pins the account home to wherever the conversation actually lives, which is not
  // necessarily the one a fresh create would pick: Codex resolves its rollout under
  // `accountHome.path`, and Claude reads its transcript under `<home>/projects`. Resuming under
  // the wrong home finds nothing and lands the user in a blank chat wearing the old chat's name.
  const adoption = await resolveStructuredAgentSessionAdoptionForCreate({
    host,
    settings: input.settings,
    agent,
    providerSessionId: resumeFrom.providerSessionId,
    selfSessionId,
    selectedAccountHomePath: selected.path
  })
  return {
    accountHome: { variable: selected.variable, path: adoption.accountHomePath },
    adopted: {
      providerSessionId: resumeFrom.providerSessionId,
      transcriptPath: adoption.transcriptPath
    }
  }
}
