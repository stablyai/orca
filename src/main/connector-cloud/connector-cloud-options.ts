import type { ConnectorMachine } from './connector-machine'
import type { ConnectorReplyJournal } from './connector-reply-outbox'
import type { ConnectorTokenMint } from './connector-transport'

export type ConnectorCloudOptions = {
  userDataPath: string
  origin: string
  machine: ConnectorMachine
  /** The signed-in Orca account, or null while signed out. */
  account: () => string | null
  /** Quitting or relaunching into another profile: nothing new starts, as for the relay. */
  isFenced: () => boolean
  /** Mints connector tokens for one account and no other. */
  mintFor: (account: string) => ConnectorTokenMint
  /** `status()` may have changed. */
  onStatusChanged?: () => void
  /** The signed-in account is another one, or none: setups in flight belong to the old one. */
  onAccountSwitched?: () => void
  fetchImpl?: typeof globalThis.fetch
  /** The journal's reply outbox (design item 125); null while no journal is open. */
  replyJournal?: () => ConnectorReplyJournal | null
}
