import {
  MOBILE_WEB_SPEECH_STOP_TIMEOUT_MS,
  MobileWebSpeechCancelPayloadSchema,
  MobileWebSpeechCancelResultSchema,
  MobileWebSpeechConfigurePayloadSchema,
  MobileWebSpeechConfigureResultSchema,
  MobileWebSpeechDeleteModelResultSchema,
  MobileWebSpeechModelActionPayloadSchema,
  MobileWebSpeechModelActionResultSchema,
  MobileWebSpeechSetupPayloadSchema,
  MobileWebSpeechSetupResultSchema,
  MobileWebSpeechStartPayloadSchema,
  MobileWebSpeechStartResultSchema,
  MobileWebSpeechStopPayloadSchema,
  MobileWebSpeechStopResultSchema,
  type MobileWebSpeechConfigurePayload,
  type MobileWebSpeechEvent
} from '../../shared/mobile-web/speech-operation-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
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

  setup() {
    return this.requests.request(
      'speech',
      'setup',
      {},
      MobileWebSpeechSetupPayloadSchema,
      MobileWebSpeechSetupResultSchema
    )
  }

  downloadModel(modelId: string) {
    return this.requests.request(
      'speech',
      'downloadModel',
      { modelId },
      MobileWebSpeechModelActionPayloadSchema,
      MobileWebSpeechModelActionResultSchema
    )
  }

  deleteModel(modelId: string) {
    return this.requests.request(
      'speech',
      'deleteModel',
      { modelId },
      MobileWebSpeechModelActionPayloadSchema,
      MobileWebSpeechDeleteModelResultSchema
    )
  }

  configure(payload: MobileWebSpeechConfigurePayload) {
    return this.requests
      .request(
        'speech',
        'configure',
        payload,
        MobileWebSpeechConfigurePayloadSchema,
        MobileWebSpeechConfigureResultSchema
      )
      .then((result) => {
        if (
          (payload.enabled !== undefined && result.enabled !== payload.enabled) ||
          (payload.modelId !== undefined && result.selectedModelId !== payload.modelId) ||
          (payload.dictationMode !== undefined && result.dictationMode !== payload.dictationMode)
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
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
