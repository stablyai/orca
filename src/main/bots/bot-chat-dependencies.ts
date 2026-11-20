// What a bot's Chat sessions need from the host, apart from the sessions themselves.
import type { Bot } from '../../shared/bot-types'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import type { StructuredAgentTurnHost } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import type {
  StructuredAgentSessionCloseOptions,
  StructuredAgentSessionCloseOutcome
} from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import type { BotController } from './bot-controller'
import type { BotHomeHost } from './bot-home-chat-name'

export type BotChatHost = StructuredAgentTurnHost &
  BotHomeHost & {
    deps: {
      store: Pick<
        StructuredAgentSessionHost['deps']['store'],
        'getConversation' | 'requireWritableRecord'
      >
    }
  }

export type BotChatDependencies = {
  bots: Pick<BotController, 'list' | 'setChatSession'>
  /** Installs the native-chat host on first use. */
  host: () => Promise<BotChatHost>
  /** Creates `sessionId` at rest, with its tab, in the bot's home; its first message starts it. */
  createChat: (bot: Bot, sessionId: string) => Promise<void>
  /** Shows the Chat's tab again if it was closed. */
  showTab: (bot: Bot, sessionId: string) => Promise<void>
  /** Stops the Chat and removes its tab; its history stays. A close that cannot be proven keeps the tab. */
  closeChat: (
    sessionId: string,
    /** Last word in the session lane before the stop; refusing keeps the Chat. */
    admitClose?: StructuredAgentSessionCloseOptions['admitClose']
  ) => Promise<Pick<StructuredAgentSessionCloseOutcome, 'stopped' | 'reason'>>
}
