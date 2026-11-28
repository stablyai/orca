import type { ConnectorEvent } from '../../shared/connectors/connector-cloud-contract'
import { CONNECTOR_AUDIENCE_EVENTS_VERSION } from '../../shared/connectors/connector-cloud-contract'
import {
  CONNECTOR_SLACK_PRESENTATION_EVENTS_PATH,
  SLACK_PRESENTATION_EVENT_VERSION,
  SLACK_PRESENTATION_TURN_END_VERSION
} from '../../shared/connectors/slack-answer-presentation'
import type { ConversationWatchListener } from '../external-conversations/external-conversation-events'
import type { ConnectorFailure } from './connector-cloud-request'
import type { ConnectorTurnEvents } from './connector-turn-events'
import { answerFor, takesPreparedEvent } from './connector-event-wire'

/** A hello's event watch and protocol fence; rejected audience batches are rebuilt, never downgraded. */
export class ConnectorEventRequests {
  private release: (() => void) | null = null
  private pause: Promise<null> | null = null
  private presentationRehelloGeneration: number | undefined

  constructor(
    private readonly deps: {
      events: ConnectorTurnEvents
      watch: (listener: ConversationWatchListener) => () => void
      observe: ConversationWatchListener
      flush: () => void
      post: (
        body: unknown,
        helloRev: number,
        events: readonly ConnectorEvent[],
        presented: boolean,
        path?: string
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
    queued: ConnectorEvent[],
    helloRev: number,
    seq: number
  ): Promise<ConnectorFailure | null> {
    const { features, presentationGeneration } = this.deps.events
    // Refuse an unsupported prepared body before projection can strip it and acknowledge the debt.
    if (
      queued.some(
        (event) =>
          (event.kind === 'turn-ended' || event.kind === 'reply') &&
          event.presentation &&
          !takesPreparedEvent(features, event.kind === 'turn-ended')
      )
    ) {
      return {
        ok: false,
        status: 400,
        error: 'presentation_receiver_unavailable',
        retryAfterMs: null
      }
    }
    const events = queued.map((event) => answerFor(event, features))
    const v = this.deps.events.requestVersion(helloRev)
    const presentedTurnEnd = events.some(
      (event) => event.kind === 'turn-ended' && event.presentation
    )
    const presentedReply =
      !presentedTurnEnd && events.some((event) => event.kind === 'reply' && event.presentation)
    const presented = presentedTurnEnd || presentedReply
    const body = {
      v: presentedTurnEnd
        ? SLACK_PRESENTATION_TURN_END_VERSION
        : presentedReply
          ? SLACK_PRESENTATION_EVENT_VERSION
          : v,
      helloRev,
      seq,
      events
    }
    let failure = await this.deps.post(body, helloRev, events, presented)
    if ((failure?.status === 400 || failure?.status === 413) && presented && events.length === 1) {
      const compatible = await this.deps.post(
        body,
        helloRev,
        events,
        true,
        CONNECTOR_SLACK_PRESENTATION_EVENTS_PATH
      )
      if (compatible?.status !== 404) {
        failure = compatible
      }
    }
    if (failure?.status === 400) {
      // An older receiver rejects the version before it can apply any event.
      if (presented && this.presentationRehelloGeneration !== presentationGeneration) {
        if (this.rehello(helloRev, failure)) {
          this.presentationRehelloGeneration = presentationGeneration
        }
      } else if (
        !presented &&
        v === CONNECTOR_AUDIENCE_EVENTS_VERSION &&
        !events.some((event) => event.kind === 'reply')
      ) {
        this.rehello(helloRev, failure)
      }
    }
    return failure
  }

  private rehello(helloRev: number, failure: ConnectorFailure): boolean {
    const pause = this.deps.rejected(helloRev, failure)
    if (pause) {
      this.pause = pause
      this.stop()
      this.deps.events.resetLive()
    }
    return pause !== null
  }
}
