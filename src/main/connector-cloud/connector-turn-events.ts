// The seam's watch, as the cloud reads it. Turn ends wait in an owner-only file so a restart still reports them.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { CONNECTOR_CLIENT_LIMITS, type ConnectorEvent } from '../../shared/connector-cloud-contract'
import { writeSecureJsonFile } from '../../shared/secure-file'
import type {
  ConversationEvent,
  ConversationSnapshot
} from '../external-conversations/external-conversation-events'
import { isMissingFileError } from '../runtime/device-registry-corruption'
import { ConnectorOutbox, type ConnectorOutboxHead, type ConnectorStamp } from './connector-outbox'
import { connectorSnapshot, jsonBytes, slackConversation, unsupported } from './connector-snapshot'

const TURN_OUTBOX_FILE = 'connector-turn-outbox.json'
const MAX_TURN_ENDS = 200
// Live events past this are dropped oldest first; a fresh hello and snapshot then restate them.
const MAX_LIVE_EVENTS = 500
// Room for the request's own fields around its events.
const EVENTS_BUDGET_BYTES = CONNECTOR_CLIENT_LIMITS.maxRequestBytes - 1024

type TurnEnded = Extract<ConnectorEvent, { kind: 'turn-ended' }>

// Tagged with the account that produced them, so another account never sends them after a relaunch.
const StoredOutbox = z.object({
  account: z.string().min(1),
  turnEnds: z.array(
    z.object({
      kind: z.literal('turn-ended'),
      conversation: z.object({ source: z.literal('slack'), externalId: z.string().min(1) }),
      paneKey: z.string().min(1),
      turnId: z.number(),
      at: z.number(),
      stopReason: z.string().min(1).nullable(),
      lastAssistantMessage: z.string().optional()
    })
  )
})

const isTurnEnded = (event: ConnectorEvent): event is TurnEnded => event.kind === 'turn-ended'
const isLive = (event: ConnectorEvent): boolean =>
  event.kind !== 'turn-ended' && event.kind !== 'snapshot'

/** Cut on a character boundary so the cloud's byte limit always holds. */
function capUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.byteLength <= maxBytes) {
    return text
  }
  let end = maxBytes
  // Step back over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--
  }
  return bytes.subarray(0, end).toString('utf8')
}

/** As many leading events as fit in one request, and at least one. */
function eventsHeadSize(events: readonly ConnectorEvent[]): number {
  let bytes = 0
  for (const [index, event] of events.entries()) {
    bytes += jsonBytes(event) + 1
    if (bytes > EVENTS_BUDGET_BYTES) {
      return Math.max(1, index)
    }
  }
  return events.length
}

/** Within the per-event cap. */
function promptEvent(event: Extract<ConnectorEvent, { kind: 'prompt' }>): ConnectorEvent {
  return jsonBytes(event) <= CONNECTOR_CLIENT_LIMITS.maxEventBytes
    ? event
    : { ...event, prompt: unsupported(event.prompt) }
}

export function toConnectorEvent(event: ConversationEvent): ConnectorEvent | null {
  const conversation = slackConversation(event.conversation)
  if (!conversation) {
    return null
  }
  const { paneKey } = event
  switch (event.kind) {
    case 'linked':
      return { kind: 'linked', conversation, paneKey, agent: event.agent }
    case 'prompt':
      return promptEvent({ kind: 'prompt', conversation, paneKey, prompt: event.prompt })
    case 'turn-started':
      return { kind: 'turn-started', conversation, paneKey, at: event.at }
    case 'turn-ended':
      // Without its start the cloud cannot place the turn; the next snapshot marks it unverifiable.
      return event.turnId === null
        ? null
        : {
            kind: 'turn-ended',
            conversation,
            paneKey,
            turnId: event.turnId,
            at: event.at,
            stopReason: event.stopReason,
            ...(event.lastAssistantMessage
              ? {
                  lastAssistantMessage: capUtf8(
                    event.lastAssistantMessage,
                    CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes
                  )
                }
              : {})
          }
  }
}

/**
 * Keeps the newest turn ends and live events within their caps, never trimming the first `sent`, so memory
 * and disk hold the same set. A snapshot is never dropped: it opens its hello.
 */
function boundEvents(events: ConnectorEvent[], sent: number): ConnectorEvent[] {
  let turnEndsOver = events.filter(isTurnEnded).length - MAX_TURN_ENDS
  let liveOver = events.filter(isLive).length - MAX_LIVE_EVENTS
  if (turnEndsOver <= 0 && liveOver <= 0) {
    return events
  }
  return events.filter(
    (event, index) =>
      index < sent || (isTurnEnded(event) ? turnEndsOver-- <= 0 : !isLive(event) || liveOver-- <= 0)
  )
}

/**
 * One account's events for the cloud, in order, owned once per process so a replacement client never
 * races a retired one over the file. Turn ends also wait on disk until the cloud accepts them.
 */
export class ConnectorTurnEvents {
  private readonly outbox: ConnectorOutbox<ConnectorEvent>
  private readonly filePath: string
  // Something owed was dropped to stay within the caps; only a fresh snapshot restates it.
  private dropped = false
  private warnedTrimmed = false

  constructor(
    userDataPath: string,
    readonly account: string
  ) {
    this.filePath = join(userDataPath, TURN_OUTBOX_FILE)
    this.outbox = new ConnectorOutbox<ConnectorEvent>({
      headSize: eventsHeadSize,
      initial: this.readStored(),
      bound: (events, sent) => {
        const kept = boundEvents(events, sent)
        this.dropped ||= kept.length < events.length
        return kept
      },
      onChange: (events) => this.store(events)
    })
  }

  /** True until the next snapshot once the caps dropped an event. */
  get needsSnapshot(): boolean {
    return this.dropped
  }

  /**
   * A snapshot opens a hello's events: it goes first, numbered 0, and replaces every live event still
   * owed; only turn ends carry over. Everything else follows in order.
   */
  observe(event: ConversationSnapshot | ConversationEvent): void {
    if (event.kind === 'snapshot') {
      const { snapshot, trimmed } = connectorSnapshot(event, Date.now())
      if (trimmed && !this.warnedTrimmed) {
        this.warnedTrimmed = true
        console.warn('[connector] a snapshot left out some active conversations to fit its caps')
      }
      this.dropped = false
      this.outbox.restart([snapshot], isTurnEnded)
      return
    }
    const wire = toConnectorEvent(event)
    if (wire) {
      this.outbox.push(wire)
    }
  }

  next(helloRev: number): ConnectorOutboxHead<ConnectorEvent> | null {
    return this.outbox.next(helloRev)
  }

  accepted(stamp: ConnectorStamp): void {
    this.outbox.accepted(stamp)
  }

  refused(stamp: ConnectorStamp): ConnectorEvent | null {
    return this.outbox.refused(stamp)
  }

  /** Drops everything, file included: no other account can report these turns. */
  clear(): void {
    this.outbox.restart([], () => false)
  }

  /** The same, before any owner exists in this process. */
  static clearStored(userDataPath: string): void {
    rmSync(join(userDataPath, TURN_OUTBOX_FILE), { force: true })
  }

  private readStored(): ConnectorEvent[] {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) {
        return []
      }
      throw error
    }
    try {
      const parsed = StoredOutbox.safeParse(JSON.parse(raw))
      return parsed.success && parsed.data.account === this.account ? parsed.data.turnEnds : []
    } catch {
      return []
    }
  }

  private store(events: readonly ConnectorEvent[]): void {
    const turnEnds = events.filter(isTurnEnded)
    if (turnEnds.length === 0) {
      rmSync(this.filePath, { force: true })
    } else {
      writeSecureJsonFile(this.filePath, { account: this.account, turnEnds })
    }
  }
}
