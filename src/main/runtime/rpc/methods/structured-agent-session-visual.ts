// Resolve readVisual scratch roots from host records; clients supply only session id/bare name.
// Older hosts lack the method (mobile may see forbidden); clients show unavailable.

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  ReadVisualParams,
  type AgentSessionReadVisualResult
} from '../../../../shared/rpc-contract/agent-session-visual-params'
import { nativeChatScratchFolderFor } from '../../../native-chat/native-chat-scratch-folder'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { readNativeChatVisualFile } from '../../../native-chat/native-chat-visual-file-read'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_VISUAL_METHODS = [
  defineMethod({
    name: 'agentSession.readVisual',
    permission: 'workspace',
    params: ReadVisualParams,
    handler: async (params, ctx): Promise<AgentSessionReadVisualResult> => {
      const host = await requireInstalledStructuredHost(ctx)
      const record = host.deps.store.getConversation(params.sessionId)
      if (!record) {
        return { ok: false, error: 'session_not_found' }
      }
      // Only host-local structured sessions have scratch folders this process can read.
      if (
        record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
        record.location.wslDistro
      ) {
        return { ok: false, error: 'unsupported_location' }
      }
      // The same state directory the chat host and its journal are opened in on this process.
      const folder = nativeChatScratchFolderFor(getProfileUserDataPath(), params.sessionId)
      return readNativeChatVisualFile(folder, params.file, params.knownRevision)
    }
  })
]
