import type { BotChangeScope } from '../../shared/bots/bot-change-scope'

/** The host's notice that a bot, its automations or its Activity's work changed, with what it covers. */
export type BotChangesApi = {
  onChanged: (callback: (scope: BotChangeScope | undefined) => void) => () => void
}
