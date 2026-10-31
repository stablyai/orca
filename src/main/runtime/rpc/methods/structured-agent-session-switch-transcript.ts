import {
  prepareStructuredChatCliTranscript,
  resolveStructuredChatCliSource,
  StructuredChatTranscriptError
} from '../../../ai-vault/structured-chat-cli-fork'
import type { AiVaultChatForkSource } from '../../../../shared/ai-vault-resume-preparation'
import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import type { OrcaRuntimeService } from '../../orca-runtime'

/**
 * The transcript a switch opens, with its failures typed for the user. `saved`: the chat already
 * shows saved turns, so a file that is gone is history Orca cannot read, never "not saved yet".
 * Other preconditions (a rewind waiting for its next message, a moved chat) keep their own errors.
 */
export async function prepareSwitchCliTranscript(
  runtime: Pick<OrcaRuntimeService, 'prepareAiVaultSessionResume'>,
  sessionId: string,
  workspaceId: string,
  saved: boolean
): Promise<AiVaultChatForkSource> {
  const refuse = (reason: StructuredChatTranscriptError['reason']) =>
    agentSessionRefusalError('agent_session_identity_required', {
      reason: saved ? 'transcriptUnreadable' : reason
    })
  try {
    const prepared = await prepareStructuredChatCliTranscript(
      await resolveStructuredChatCliSource({ sessionId, workspaceId }, false),
      (args) => runtime.prepareAiVaultSessionResume(args),
      false
    )
    if (!prepared.cliForkSource) {
      throw refuse('transcriptNotFound')
    }
    return prepared.cliForkSource
  } catch (error) {
    throw error instanceof StructuredChatTranscriptError ? refuse(error.reason) : error
  }
}
