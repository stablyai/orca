import {
  MOBILE_WEB_SPEECH_STOP_TIMEOUT_MS,
  MobileWebSpeechCancelPayloadSchema,
  MobileWebSpeechCancelResultSchema,
  MobileWebSpeechStartPayloadSchema,
  MobileWebSpeechStartResultSchema,
  MobileWebSpeechStopPayloadSchema,
  MobileWebSpeechStopResultSchema,
  type MobileWebSpeechEvent
} from '../../shared/mobile-web/speech-operation-contract'
import type { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'

export class MobileWebSpeechRequestClient {
  constructor(
    private readonly requests: MobileWebOneShotRequestClient,
    private readonly subscriptions: MobileWebBridgeSubscriptionClient
  ) {}

  subscribe(
    onEvent: (event: MobileWebSpeechEvent) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebBridgeSubscription {
    return this.subscriptions.subscribeSpeech(onEvent, onError)
  }

  start() {
    return this.requests.request(
      'speech',
      'start',
      {},
      MobileWebSpeechStartPayloadSchema,
      MobileWebSpeechStartResultSchema
    )
  }

  stop() {
    return this.requests.request(
      'speech',
      'stop',
      {},
      MobileWebSpeechStopPayloadSchema,
      MobileWebSpeechStopResultSchema,
      { timeoutMs: MOBILE_WEB_SPEECH_STOP_TIMEOUT_MS }
    )
  }

  cancel() {
    return this.requests.request(
      'speech',
      'cancel',
      {},
      MobileWebSpeechCancelPayloadSchema,
      MobileWebSpeechCancelResultSchema
    )
  }
}
