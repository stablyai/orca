import type { SharedBotHostsState } from '../../shared/bots/shared-bot-hosts'

/** The agents shared with this Orca account, and held messages sent again. */
export type SharedBotHostsApi = {
  list: () => Promise<SharedBotHostsState>
  onChanged: (callback: (state: SharedBotHostsState) => void) => () => void
  /** Holds a message the host refused again, under a new id; false when nothing was held. */
  sendAgain: (args: { environmentId: string; clientMessageId: string }) => Promise<boolean>
}
