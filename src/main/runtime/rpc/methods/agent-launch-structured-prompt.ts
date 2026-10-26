/** Send through the clients' body/envelope builders and the journal's existing submission row; a second host queue could disagree.
 * The renderer still delivers its own prompts until its launcher uses agent.launch. */

import {
  structuredAgentSessionMessageSendMutation,
  structuredAgentSessionSendBody
} from '../../../../shared/structured-agent-session-send-mutation'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'
import { randomUUID } from 'node:crypto'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'

/** Return an id only for a proven journal commit, reconciling throws after append to avoid duplicate turns.
 * Do not wait for provider dispatch: the submission owns whether the provider took the committed turn. */
export async function commitStructuredAgentSessionLaunchPrompt(args: {
  host: StructuredAgentSessionHost | null
  caller: StructuredAgentSessionCaller
  sessionId: string
  fence: number
  text: string
}): Promise<string | null> {
  if (!args.host || args.text.trim().length === 0) {
    return null
  }
  const clientMessageId = createStructuredAgentSessionOperationId(randomUUID)
  try {
    const result = await args.host.send(args.caller, {
      ...structuredAgentSessionMessageSendMutation({
        sessionId: args.sessionId,
        clientOperationId: clientMessageId,
        expectedRuntimeFence: args.fence,
        body: structuredAgentSessionSendBody(args.text, [])
      }),
      // A person's first prompt, sent for them: kept as a card if a restart or a close comes first.
      personsMessage: true
    })
    return result.ok ? result.value.clientMessageId : null
  } catch (error) {
    // Settlement can fail after append; reconcile the journal before asking the caller to resend.
    try {
      const committed = (await args.host.journalSnapshot(args.sessionId)).submissions.find(
        (submission) => submission.clientMessageId === clientMessageId
      )
      if (committed) {
        return clientMessageId
      }
    } catch {
      // The host may have gone away before the snapshot; the caller retains the text in that case.
    }
    args.host.deps.logger.warn("sending a created chat's launch prompt failed", {
      scope: 'launch-prompt',
      sessionId: args.sessionId,
      error
    })
    return null
  }
}
