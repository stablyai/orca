import { defineMethod } from '../core'
import { rpcCallerOperationKey } from '../rpc-caller-identity'
import {
  readNativeChatCurrentRequests,
  cancelNativeChatCurrentQuestions
} from '../../../native-chat/native-chat-current-requests'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { AGENT_SESSION_CURRENT_REQUESTS_V2 } from '../../../../shared/agent-session-current-requests-capability'
import { nativeChatTranscriptPathOnExecutionHost } from '../../../native-chat/ssh-transcript-path'
import {
  NativeChatCurrentRequests,
  NativeChatCancelCurrentQuestions
} from '../../../../shared/rpc-contract/native-chat-params'

export const NATIVE_CHAT_CURRENT_REQUEST_METHODS = [
  defineMethod({
    name: 'nativeChat.currentRequests',
    permission: 'workspace',
    params: NativeChatCurrentRequests,
    handler: async (params, { runtime, clientCapabilities, signal }) => {
      if (!clientCapabilities?.includes(AGENT_SESSION_CURRENT_REQUESTS_V2)) {
        throw new Error('Current questions capability required')
      }
      const deadline = AbortSignal.timeout(15_000)
      const ownedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      await waitForPromiseWithSignal(runtime.ensureStructuredAgentSessionHost(), ownedSignal)
      return readNativeChatCurrentRequests(
        {
          ...params,
          transcriptPath: nativeChatTranscriptPathOnExecutionHost(
            runtime.getAgentProviderSessionRows(),
            params.sessionId,
            params.transcriptPath
          )
        },
        ownedSignal
      )
    }
  }),
  defineMethod({
    name: 'nativeChat.cancelCurrentQuestions',
    permission: 'workspace',
    params: NativeChatCancelCurrentQuestions,
    handler: async (params, { runtime, clientCapabilities, caller, signal }) => {
      if (!clientCapabilities?.includes(AGENT_SESSION_CURRENT_REQUESTS_V2) || !caller) {
        throw new Error('Current questions capability and authenticated caller required')
      }
      const deadline = AbortSignal.timeout(15_000)
      const ownedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
      await waitForPromiseWithSignal(runtime.ensureStructuredAgentSessionHost(), ownedSignal)
      await cancelNativeChatCurrentQuestions(
        {
          ...params,
          transcriptPath: nativeChatTranscriptPathOnExecutionHost(
            runtime.getAgentProviderSessionRows(),
            params.sessionId,
            params.transcriptPath
          )
        },
        rpcCallerOperationKey(caller),
        ownedSignal
      )
      return { cancelled: true }
    }
  })
]
