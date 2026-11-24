// What a hello says about this machine, always within the cloud's request cap.
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  CONNECTOR_ANSWER_TEXT_FEATURE,
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_CONTRACT_VERSION,
  CONNECTOR_REPLIES_OUTBOX_FEATURE,
  CONNECTOR_RESUME_FEATURE,
  CONNECTOR_PATHS,
  ConnectorHelloResponse,
  type ConnectorBot,
  type ConnectorCloudFeature,
  type ConnectorTrigger
} from '../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_WAKE_FEATURE,
  ConnectorHelloWakeOfferSchema
} from '../../../cloud/packages/connector-contract/src/wake-messages'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorMachine, ConnectorTransport } from './connector-machine'
import { jsonBytes } from './connector-snapshot'

// turnCancel: a cancel naming a turn is refused once that turn is no longer current. trigger: trigger
// deliveries start bot automations. webhook: so do hooks' calls, which this machine fetches and runs.
// prEvents: pull request events for its bots' workers, listed only while it takes them. batchedSends:
// a conversation's sends that queued behind its start or send come in one poll and run as one turn.
// ownDmChats: a bot start for a DM that ran in the bot's Chat opens the DM a chat of its own.
// askerNote: Orca's lines on where a bot was asked come apart from the asker's words.
// connector-wake-v1: takes a wake offer (connector-wake-channel.ts). resume: a send's `resume`
// continues a chat whose newest turn failed (external-conversation-resume.ts).
const FEATURES = [
  'answer',
  CONNECTOR_ANSWER_TEXT_FEATURE,
  'cancel',
  'reply',
  'turnCancel',
  'trigger',
  'webhook',
  'triggerInTurn',
  'threadCatchUp',
  'batchedSends',
  'ownDmChats',
  'askerNote',
  'slackThreadReplies',
  CONNECTOR_REPLIES_OUTBOX_FEATURE,
  CONNECTOR_WAKE_FEATURE,
  CONNECTOR_RESUME_FEATURE
]
const PROMPT_KINDS = ['approval', 'question']
// Listed by hand: a source joins only once this build's seam handles its conversations.
const SOURCES = ['slack', 'linear', 'github']

// The answer as this machine reads it: the shared contract's wake offer beside the rest.
export const ConnectorHelloAnswer = ConnectorHelloResponse.extend({
  wake: ConnectorHelloWakeOfferSchema
})

export type ConnectorHelloSaid = {
  /** Null: left out, so the cloud keeps the bots it has until its answer says whether it takes pages. */
  bots: ConnectorBot[] | null
  /** Sent in pages before the hello, which names them. */
  paged: boolean
  /** Only the first bots, to an older cloud that takes no pages. */
  cut: boolean
  triggers: ConnectorTrigger[]
}

/**
 * What the next hello says to a cloud whose last answer listed `cloudFeatures` (null before one).
 * The cloud replaces a host's bots with what a hello lists, so more than one hello holds never go as
 * a partial list a cloud with pages would read as complete: they wait for its answer, then go in
 * pages, or (to an older cloud) as the first ones in saved order, as before.
 */
export function connectorHelloSaid(
  machine: ConnectorMachine,
  cloudFeatures: ReadonlySet<string> | null
): ConnectorHelloSaid {
  const bots = machine.bots()
  const triggers = machine.triggers()
  const { maxHelloBots } = CONNECTOR_CLIENT_LIMITS
  if (bots.length <= maxHelloBots) {
    return { bots, paged: false, cut: false, triggers }
  }
  if (cloudFeatures === null) {
    return { bots: null, paged: false, cut: false, triggers }
  }
  return cloudFeatures.has('bots.pages' satisfies ConnectorCloudFeature)
    ? { bots, paged: true, cut: false, triggers }
    : { bots: bots.slice(0, maxHelloBots), paged: false, cut: true, triggers }
}

/** Says `said`, after staging a paged hello's bots: the cloud's answer, and whether it left any out. */
export async function sayConnectorHello(
  machine: ConnectorMachine,
  said: ConnectorHelloSaid,
  transport: ConnectorTransport,
  signal: AbortSignal
): Promise<ConnectorResult<{ answer: z.infer<typeof ConnectorHelloAnswer>; trimmed: boolean }>> {
  let botPages: { inventoryId: string; pages: number } | undefined
  if (said.paged && said.bots) {
    const { maxHelloBots } = CONNECTOR_CLIENT_LIMITS
    // Fresh each hello: the cloud's hello takes the pages it names, so a retry stages them again.
    botPages = { inventoryId: randomUUID(), pages: Math.ceil(said.bots.length / maxHelloBots) }
    for (let index = 0; index < botPages.pages; index++) {
      const bots = said.bots.slice(index * maxHelloBots, (index + 1) * maxHelloBots)
      const staged = await transport.call(
        CONNECTOR_PATHS.botPages,
        { v: 1, ...botPages, index, bots },
        z.undefined(),
        { method: 'PUT', signal }
      )
      if (!staged.ok) {
        return staged
      }
    }
  }
  const { body, trimmed } = connectorHello(machine, said, botPages)
  const answer = await transport.call(CONNECTOR_PATHS.hello, body, ConnectorHelloAnswer, {
    method: 'PUT',
    signal
  })
  return answer.ok ? { ok: true, value: { answer: answer.value, trimmed } } : answer
}

/**
 * The hello body. Inline bots always fit: each is cut to its share of the request cap
 * (connector-places.ts), which leaves room for triggers up to their cap.
 */
export function connectorHello(
  machine: ConnectorMachine,
  said: ConnectorHelloSaid,
  /** For a paged hello: the staged pages it names. */
  botPages?: { inventoryId: string; pages: number }
): { body: unknown; trimmed: boolean } {
  const envelope = {
    v: 1,
    contract: CONNECTOR_CONTRACT_VERSION,
    orcaVersion: machine.orcaVersion,
    platform: process.platform,
    runtime: machine.runtime,
    hostName: machine.hostName(),
    // Older clouds require both lists; they stay empty now that only bots start conversations.
    // TODO: drop both once every connector cloud ships the contract without them.
    agents: [],
    projects: [],
    promptKinds: PROMPT_KINDS,
    features: machine.prEvent ? [...FEATURES, 'prEvents'] : FEATURES,
    sources: SOURCES,
    ...(botPages ? { botPages } : said.bots ? { bots: said.bots } : {})
  }
  let bytes = jsonBytes({ ...envelope, triggers: [], triggersTruncated: false })
  const fitting = <T>(entries: readonly T[]): T[] => {
    let count = 0
    for (const entry of entries) {
      // Each entry adds its JSON and a comma.
      if (bytes + jsonBytes(entry) + 1 > CONNECTOR_CLIENT_LIMITS.maxRequestBytes) {
        break
      }
      bytes += jsonBytes(entry) + 1
      count++
    }
    return entries.slice(0, count)
  }
  const triggers = fitting(said.triggers.slice(0, CONNECTOR_CLIENT_LIMITS.maxHelloTriggers))
  // Lets the cloud tell a rule this machine dropped from one that didn't fit.
  const triggersTruncated = triggers.length < said.triggers.length
  return {
    body: { ...envelope, triggers, triggersTruncated },
    trimmed: triggersTruncated || said.cut
  }
}
