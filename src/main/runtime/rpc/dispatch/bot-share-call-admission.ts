// The share guard, run once per call after its params parse: a teammate's call may name only the shared
// bot and its chats, whoever they are for. Anything else answers not found, so another agent's chat never shows.
import { getAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcMethodShare } from '../../../../shared/bots/bot-share-rpc-methods'
import type { BotShareCallerScope } from '../callers/rpc-caller-scope'
import { botShareReachesSession } from '../../../bots/team-share/bot-share-chats'
import {
  confineBotShareFolderRead,
  confinedFolderParams
} from '../../../bots/team-share/bot-share-folder'

export type BotShareRefusal =
  | 'bot_not_found'
  | 'session_not_found'
  | 'method_not_found'
  | 'path_not_found'

export async function refuseBotShareCall(
  runtime: OrcaRuntimeService,
  scope: BotShareCallerScope,
  share: RpcMethodShare,
  params: unknown
): Promise<BotShareRefusal | null> {
  const access = share === 'not-shared' ? undefined : share
  switch (access?.kind) {
    case 'scoped':
    case 'self':
      return null
    case 'bot':
      return access.botId(params) === scope.botId ? null : 'bot_not_found'
    case 'chat': {
      const sessionId = access.sessionId(params)
      if (sessionId === undefined) {
        return 'session_not_found'
      }
      // The chat records live in the chat host, which opens lazily.
      await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      return botShareReachesSession(runtime, scope, sessionId) ? null : 'session_not_found'
    }
    case 'attachment': {
      const path = access.path(params)
      // The attachment store is set up with the chat host, which opens lazily: open it first.
      await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      const claimed = path
        ? ((await getAgentSessionAttachmentStore()?.claimingSessions(path)) ?? [])
        : []
      return claimed.some((sessionId) => botShareReachesSession(runtime, scope, sessionId))
        ? null
        : 'session_not_found'
    }
    case 'bot-folder':
      return (await confineBotShareFolderRead(runtime, scope, access.read(params)))
        ? null
        : 'path_not_found'
    case undefined:
      return 'method_not_found'
  }
}

/** The guard's answer: a refusal, or the params the call runs with. A folder read runs confined: on
 *  the path admission resolved, with symlinks off, whatever the caller sent or the host's setting. */
export async function admitBotShareCall(
  runtime: OrcaRuntimeService,
  scope: BotShareCallerScope,
  share: RpcMethodShare,
  params: unknown
): Promise<{ refusal: BotShareRefusal } | { params: unknown }> {
  if (share !== 'not-shared' && share.kind === 'bot-folder') {
    const confined = await confineBotShareFolderRead(runtime, scope, share.read(params))
    return confined
      ? { params: confinedFolderParams(params, confined) }
      : { refusal: 'path_not_found' }
  }
  const refusal = await refuseBotShareCall(runtime, scope, share, params)
  return refusal ? { refusal } : { params }
}
