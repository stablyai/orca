// `agentSession.readVisual` — one HTML visual from a chat's own visuals folder.
//
// Additive: an older host answers `method_not_found` (a phone gets `forbidden` from the mobile
// allowlist gate on a host without the entry), and the client shows the visual as unavailable.
// The host resolves the folder from its own state directory and record; a client supplies only the
// session id and a bare file name.

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  ReadVisualParams,
  type AgentSessionReadVisualResult
} from '../../../../shared/rpc-contract/agent-session-visual-params'
import { nativeChatVisualsFolderFor } from '../../../native-chat/native-chat-visuals-folder'
import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import { readNativeChatVisualFile } from '../../../native-chat/native-chat-visual-file-read'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_VISUAL_METHODS = [
  defineMethod({
    name: 'agentSession.readVisual',
    params: ReadVisualParams,
    handler: async (params, ctx): Promise<AgentSessionReadVisualResult> => {
      const host = await requireInstalledStructuredHost(ctx)
      const record = host.deps.store.getRecord(params.sessionId)
      if (!record) {
        return { ok: false, error: 'session_not_found' }
      }
      // Structured chats run on their owning runtime's own filesystem; any other location has no
      // visuals folder this process can read.
      if (
        record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
        record.location.wslDistro
      ) {
        return { ok: false, error: 'unsupported_location' }
      }
      // The same state directory the chat host and its journal are opened in on this process.
      const folder = nativeChatVisualsFolderFor(getProfileUserDataPath(), params.sessionId)
      return readNativeChatVisualFile(folder, params.file, params.knownRevision)
    }
  })
]
