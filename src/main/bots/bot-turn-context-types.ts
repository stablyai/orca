import type { StructuredAgentSessionTurnContext } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { BotHomeFiles } from './bot-preamble'
import type { BotLaunchedRules } from './bot-turn-rules-update'

export type BotTurnContext = StructuredAgentSessionTurnContext & {
  /** The session's agent started; `delivered` when its instructions carried these files. */
  launched: (
    sessionId: string,
    botId: string,
    folder: string,
    files: BotHomeFiles,
    delivered: boolean,
    rules: BotLaunchedRules
  ) => void
  /** The launch's linked-skills section; `delivered` when its instructions carried it. */
  linkedSkillsLaunched: (sessionId: string, section: string | null, delivered: boolean) => void
}

export type BotFirstRun = {
  /** The first-run rules for this session's next turn; null when its bot isn't in first run there. */
  rules: (botId: string, sessionId: string) => string | null
  /** A turn there ended that the owner started. */
  ownerTurnEnded: (botId: string, sessionId: string) => void
}

export type Held = string | null | undefined
