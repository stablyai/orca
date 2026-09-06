import {
  MobileWebNavigationReconnectPayloadSchema,
  MobileWebNavigationRemoveHostPayloadSchema,
  MobileWebNavigationResultSchema,
  MobileWebNavigationRoutePayloadSchema,
  type MobileWebNavigationRemoveHostPayload,
  type MobileWebNavigationRoutePayload
} from '../../shared/mobile-web/navigation-operation-contract'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebNavigationRequestClient {
  constructor(private readonly requests: MobileWebOneShotRequestClient) {}

  route(payload: MobileWebNavigationRoutePayload): Promise<null> {
    return this.requests.request(
      'navigation',
      'route',
      payload,
      MobileWebNavigationRoutePayloadSchema,
      MobileWebNavigationResultSchema
    )
  }

  reconnect(): Promise<null> {
    return this.requests.request(
      'navigation',
      'reconnect',
      {},
      MobileWebNavigationReconnectPayloadSchema,
      MobileWebNavigationResultSchema
    )
  }

  removeHost(payload: MobileWebNavigationRemoveHostPayload): Promise<null> {
    return this.requests.request(
      'navigation',
      'removeHost',
      payload,
      MobileWebNavigationRemoveHostPayloadSchema,
      MobileWebNavigationResultSchema
    )
  }
}
