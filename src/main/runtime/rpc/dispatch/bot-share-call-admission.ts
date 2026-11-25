// The share guard, run once per call after its params parse: a teammate's call may name only the shared
// bot and their own chats on it. Anything else answers not found, so another chat's existence never shows.
import { getAgentSessionAttachmentStore } from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcMethodShare } from '../../../../shared/bots/bot-share-rpc-methods'
import type { BotShareCallerScope } from '../callers/rpc-caller-scope'
import { botShareOwnsSession } from '../../../bots/team-share/bot-share-chats'

export type BotShareRefusal = 'bot_not_found' | 'session_not_found' | 'method_not_found'

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
      return botShareOwnsSession(runtime, scope, sessionId) ? null : 'session_not_found'
    }
    case 'attachment': {
      const path = access.path(params)
      // The attachment store is set up with the chat host, which opens lazily: open it first.
      await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
      const claimed = path
        ? ((await getAgentSessionAttachmentStore()?.claimingSessions(path)) ?? [])
        : []
      return claimed.some((sessionId) => botShareOwnsSession(runtime, scope, sessionId))
        ? null
        : 'session_not_found'
    }
    case undefined:
      return 'method_not_found'
  }
}
