import type { ClaudeSessionStatus } from '../../../../../shared/native-chat/claude-session-status'
import { NativeChatSession } from '../../../../../shared/rpc-contract/native-chat-params'
import { createClaudeSessionStatusReader } from '../../../../native-chat/claude-session-status-reader'
import { claudeSessionWindowTokens } from '../../../../native-chat/claude-session-window-store'
import { resolveSessionFilePath } from '../../../../native-chat/session-file-resolver'
import { nativeChatTranscriptPathOnExecutionHost } from '../../../../native-chat/ssh-transcript-path'
import { defineMethod } from '../../core'

const statusReader = createClaudeSessionStatusReader()

/** Status of a Claude chat that runs in a terminal; a null status hides the composer's readout. */
export const NATIVE_CHAT_CLAUDE_SESSION_STATUS_METHOD = defineMethod({
  name: 'nativeChat.claudeSessionStatus',
  permission: 'workspace',
  params: NativeChatSession,
  handler: async (params, { runtime, signal }): Promise<{ status: ClaudeSessionStatus | null }> => {
    if (params.agent !== 'claude') {
      return { status: null }
    }
    const transcriptPath = nativeChatTranscriptPathOnExecutionHost(
      runtime.getAgentProviderSessionRows(),
      params.sessionId,
      params.transcriptPath
    )
    const filePath = await resolveSessionFilePath(
      params.agent,
      params.sessionId,
      transcriptPath ? { transcriptPath } : {},
      signal
    )
    const facts = filePath ? await statusReader.read(filePath, signal) : null
    return {
      status: facts ? { ...facts, windowTokens: claudeSessionWindowTokens(params.sessionId) } : null
    }
  }
})
