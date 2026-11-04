import { isAgentSessionRefusalError } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { resolveStructuredAgentSessionAdoptionForCreate } from './structured-agent-session-create-adoption'

/** A conversation the CLI never saved has no history to import, so the chat starts a new one
 *  instead of refusing; an unreadable transcript still refuses. */
export async function resolveStructuredAgentSessionAdoptionForCreateOrFresh(
  input: Parameters<typeof resolveStructuredAgentSessionAdoptionForCreate>[0]
): Promise<Awaited<ReturnType<typeof resolveStructuredAgentSessionAdoptionForCreate>> | null> {
  try {
    return await resolveStructuredAgentSessionAdoptionForCreate(input)
  } catch (error) {
    if (
      !isAgentSessionRefusalError(error) ||
      error.refusal.code !== 'agent_session_identity_required' ||
      error.refusal.details?.reason !== 'transcriptNotFound'
    ) {
      throw error
    }
    console.warn(
      '[agent-session] resumed conversation has no saved transcript; starting a new chat',
      { agent: input.agent, providerSessionId: input.providerSessionId }
    )
    return null
  }
}
