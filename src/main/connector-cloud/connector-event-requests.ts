import type { ConnectorEvent } from '../../shared/connectors/connector-cloud-contract'
import { CONNECTOR_AUDIENCE_EVENTS_VERSION } from '../../shared/connectors/connector-cloud-contract'
import { SLACK_PRESENTATION_EVENT_VERSION } from '../../shared/connectors/slack-answer-presentation'
import type { ConversationWatchListener } from '../external-conversations/external-conversation-events'
import type { ConnectorFailure } from './connector-cloud-request'
import type { ConnectorTurnEvents } from './connector-turn-events'

/** A hello's event watch and protocol fence; rejected audience batches are rebuilt, never downgraded. */
export class ConnectorEventRequests {
  private release: (() => void) | null = null
  private pause: Promise<null> | null = null
  private readonly presentationRefused = new WeakSet<ConnectorEvent>()

  constructor(
    private readonly deps: {
      events: ConnectorTurnEvents
      watch: (listener: ConversationWatchListener) => () => void
      observe: ConversationWatchListener
      flush: () => void
      post: (
        body: unknown,
        helloRev: number,
        events: readonly ConnectorEvent[]
      ) => Promise<ConnectorFailure | null>
      rejected: (helloRev: number, failure: ConnectorFailure) => Promise<null> | null
    }
  ) {}

  waitForRetry(): Promise<null> | null {
    return this.pause
  }

  /** Each hello: its events flush replies the journal hands over, and the journal drains. */
  watch(): void {
    this.deps.events.useReplyFlush(this.deps.flush)
    void this.deps.events.drainReplies()
    const previous = this.release
    this.release = this.deps.watch((event) => {
      this.deps.events.observe(event)
      this.deps.observe(event)
      this.deps.flush()
    })
    previous?.()
  }

  stop(): void {
    this.deps.events.useReplyFlush(null)
    this.release?.()
    this.release = null
  }

  async post(
    events: ConnectorEvent[],
    helloRev: number,
    seq: number
  ): Promise<ConnectorFailure | null> {
    const v = this.deps.events.requestVersion(helloRev)
    const presented = events.find((event) => event.kind === 'reply' && event.presentation)
    const failure = await this.deps.post(
      { v: presented ? SLACK_PRESENTATION_EVENT_VERSION : v, helloRev, seq, events },
      helloRev,
      events
    )
    if (failure?.status === 400) {
      // An older receiver rejects the version before it can apply any event.
      if (presented && !this.presentationRefused.has(presented)) {
        this.presentationRefused.add(presented)
        this.rehello(helloRev, failure)
      } else if (
        v === CONNECTOR_AUDIENCE_EVENTS_VERSION &&
        !events.some((event) => event.kind === 'reply')
      ) {
        this.rehello(helloRev, failure)
      }
    }
    return failure
  }

  private rehello(helloRev: number, failure: ConnectorFailure): void {
    const pause = this.deps.rejected(helloRev, failure)
    if (pause) {
      this.pause = pause
      this.stop()
      this.deps.events.resetLive()
    }
  }
}
