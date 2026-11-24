// The share guard, run once per call after its params parse: a teammate's call may name only the shared
// bot and their own chats on it. Anything else answers not found, so another chat's existence never shows.
import type { OrcaRuntimeService } from '../../orca-runtime'
import { BOT_SHARE_RPC_METHODS } from '../../../../shared/bots/bot-share-rpc-methods'
import type { BotShareCallerScope } from '../callers/rpc-caller-scope'
import { botShareOwnsSession } from '../../../bots/team-share/bot-share-chats'

export async function refuseBotShareCall(
  runtime: OrcaRuntimeService,
  scope: BotShareCallerScope,
  methodName: string,
  params: unknown
): Promise<string | null> {
  const access = BOT_SHARE_RPC_METHODS.get(methodName)
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
    case undefined:
      return 'method_not_found'
  }
}
