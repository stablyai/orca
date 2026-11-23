import type { ConnectorTurnEvents } from './connector-turn-events'
import type {
  ConnectorBot,
  ConnectorDelivery,
  ConnectorDeliveryResult,
  ConnectorTrigger
} from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorTurnAutomation } from '../../shared/connector-trigger-event-contract'
import type { TurnAutomations } from './connector-turn-automations'
import type { RecordHandled } from './connector-thread-mute'
import type { ExternalConversationHost } from '../external-conversations/external-conversation-host'
import type { ExternalConversationSeam } from '../external-conversations/external-conversation-seam'
import type { ConnectorAccountTransport } from './connector-transport'
import type { ConnectorWakeSocketFactory } from './connector-wake-socket'

export type ConnectorRuntimeKind = 'desktop' | 'serve'

/** What the connector needs from this Orca. */
export type ConnectorMachine = {
  /** The desktop app, or a server: Electron `orca serve` or orcad. */
  runtime: ConnectorRuntimeKind
  orcaVersion: string
  /** Read per hello: the computer's display name (Settings, else macOS ComputerName), never the raw hostname. */
  hostName: () => string
  seam: () => ExternalConversationSeam | null
  conversationHost: () => ExternalConversationHost
  bots: () => ConnectorBot[]
  /** A bounded wait, never rejecting, for what `bots` reads asynchronously: the first hello is whole. */
  beforeFirstHello?: () => Promise<void>
  triggers: () => ConnectorTrigger[]
  /** Hands a matched event to its bot automation; false once the automation no longer takes it. */
  runTrigger: (delivery: Extract<ConnectorDelivery, { kind: 'trigger' }>) => Promise<boolean>
  /** The automations a bot's start or send also carries, run in that turn; null for none. */
  turnAutomations?: (entries: readonly ConnectorTurnAutomation[]) => TurnAutomations | null
  /** A send a bot thread's mute handles before the agent (accepted, no turn); null when it goes on
   *  now, 'send' when it goes on once its thread is linked. */
  threadMute?: (
    delivery: Extract<ConnectorDelivery, { kind: 'send' }>,
    record: RecordHandled
  ) => Promise<ConnectorDeliveryResult | 'send'> | null
  /** Tells the bot's owner about one of its hooks; false when the hook isn't this machine's. */
  webhookNotice?: (
    delivery: Extract<ConnectorDelivery, { kind: 'webhook_notice' }>
  ) => Promise<boolean>
  /** Holds the event for the wake of the bot whose worker owns the pull request, if one here does. */
  prEvent?: (delivery: Extract<ConnectorDelivery, { kind: 'pr_event' }>) => Promise<void>
  /** The cloud took a hello: what it takes now, and the hooks deleted while this machine was away. */
  helloAnswered?: (answer: { webhookTombstones?: string[] }) => void
  /** Signed out or switched account: drop what the linked conversations' cloud was last shown. */
  resetConversations?: () => void
  /** Whether the cloud can bring this machine work, so the connection is held: see hostNeedsConnector. */
  wantsConnection: () => boolean
  // Something a hello lists, or wantsConnection, may have changed: bots, automations or settings.
  onHelloInputsChanged: (listener: () => void) => void
}

/** How the client reaches the cloud as this machine; the credential behind it can change. */
export type ConnectorTransport = Pick<ConnectorAccountTransport, 'call'> &
  Partial<Pick<ConnectorAccountTransport, 'wakeToken'>>

export type ConnectorPollClientOptions = {
  transport: ConnectorTransport
  /** Owned by the caller across clients; this client only sends through it while running. */
  events: ConnectorTurnEvents
  seam: ExternalConversationSeam
  machine: ConnectorMachine
  random?: () => number
  /** Opens wake sockets; tests pass a fake. */
  wakeSocketFactory?: ConnectorWakeSocketFactory
  /** The cloud stopped this client, for good. */
  onHalt?: (reason: string) => void
}
