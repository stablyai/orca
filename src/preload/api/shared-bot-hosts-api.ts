import type { SharedBotHostsState } from '../../shared/bots/shared-bot-hosts'

/** The agents shared with this Orca account, and held messages sent again. */
export type SharedBotHostsApi = {
  list: () => Promise<SharedBotHostsState>
  onChanged: (callback: (state: SharedBotHostsState) => void) => () => void
  /** Holds a message the host refused again, under a new id; false when nothing was held. */
  sendAgain: (args: { environmentId: string; clientMessageId: string }) => Promise<boolean>
  /** Accepts a share offered to this account, which then pairs; false when it isn't offered now. */
  accept: (args: { shareId: string }) => Promise<boolean>
  /** Declines it for good; false when it isn't offered now. */
  decline: (args: { shareId: string }) => Promise<boolean>
}
