import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import {
  PtyChatSubmissionSummary,
  StructuredChatSubmissionSummary
} from '../../../../shared/rpc-contract/native-chat-submission-params'
import {
  ptyChatSubmissionSummary,
  structuredChatSubmissionSummary
} from '../../../native-chat/native-chat-submission-summary'
import { nativeChatTranscriptPathOnExecutionHost } from '../../../native-chat/ssh-transcript-path'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-sessions/creation/structured-agent-session-gate'

export const NATIVE_CHAT_SUBMISSION_SUMMARY_METHODS = [
  defineMethod({
    name: 'agentSession.submissionSummary',
    permission: 'workspace',
    params: StructuredChatSubmissionSummary,
    handler: async (params, ctx) => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      const snapshot = await waitForPromiseWithSignal(
        host.journalSnapshot(params.sessionId),
        ctx.signal
      )
      ctx.signal?.throwIfAborted()
      return structuredChatSubmissionSummary(snapshot, params.before)
    }
  }),
  defineMethod({
    name: 'nativeChat.submissionSummary',
    permission: 'workspace',
    params: PtyChatSubmissionSummary,
    handler: (params, { runtime, signal }) =>
      ptyChatSubmissionSummary(
        {
          ...params,
          transcriptPath: nativeChatTranscriptPathOnExecutionHost(
            runtime.getAgentProviderSessionRows(),
            params.sessionId,
            params.transcriptPath
          )
        },
        signal
      )
  })
]
