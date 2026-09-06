import {
  MobileWebAccountConsumeResetPayloadSchema,
  MobileWebAccountConsumeResetResultSchema,
  MobileWebAccountResetCapabilityPayloadSchema,
  MobileWebAccountResetCapabilityResultSchema,
  MobileWebAccountSelectPayloadSchema,
  MobileWebAccountSelectResultSchema,
  MobileWebAccountSnapshotPayloadSchema,
  MobileWebAccountsSnapshotSchema,
  type MobileWebAccountConsumeResetPayload,
  type MobileWebAccountConsumeResetResult,
  type MobileWebAccountEvent,
  type MobileWebAccountSelectPayload,
  type MobileWebAccountsSnapshot
} from '../../shared/mobile-web/account-operation-contract'
import type { MobileWebBridgeSubscription } from './mobile-web-bridge-subscription'
import type { MobileWebBridgeSubscriptionClient } from './mobile-web-bridge-subscription-client'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

export class MobileWebAccountRequestClient {
  constructor(
    private readonly requests: MobileWebOneShotRequestClient,
    private readonly subscriptions: MobileWebBridgeSubscriptionClient
  ) {}

  snapshot(): Promise<MobileWebAccountsSnapshot> {
    return this.requests.request(
      'account',
      'snapshot',
      {},
      MobileWebAccountSnapshotPayloadSchema,
      MobileWebAccountsSnapshotSchema
    )
  }

  select(payload: MobileWebAccountSelectPayload): Promise<null> {
    return this.requests.request(
      'account',
      'select',
      payload,
      MobileWebAccountSelectPayloadSchema,
      MobileWebAccountSelectResultSchema
    )
  }

  resetCreditCapability(): Promise<boolean> {
    return this.requests.request(
      'account',
      'resetCreditCapability',
      {},
      MobileWebAccountResetCapabilityPayloadSchema,
      MobileWebAccountResetCapabilityResultSchema
    )
  }

  consumeResetCredit(
    payload: MobileWebAccountConsumeResetPayload
  ): Promise<MobileWebAccountConsumeResetResult> {
    return this.requests
      .request(
        'account',
        'consumeResetCredit',
        payload,
        MobileWebAccountConsumeResetPayloadSchema,
        MobileWebAccountConsumeResetResultSchema
      )
      .then((result) => {
        if (!sameResetScope(result.scope, payload.expectedScope)) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  subscribe(
    onEvent: (event: MobileWebAccountEvent) => void,
    onError: (error: MobileWebBridgeClientError) => void
  ): MobileWebBridgeSubscription {
    return this.subscriptions.subscribeAccount(onEvent, onError)
  }
}

function sameResetScope(
  left: MobileWebAccountConsumeResetResult['scope'],
  right: MobileWebAccountConsumeResetPayload['expectedScope']
): boolean {
  return (
    left.target.runtime === right.target.runtime &&
    left.target.wslDistro === right.target.wslDistro &&
    left.accountId === right.accountId &&
    left.accountRevision === right.accountRevision &&
    left.offerRevision === right.offerRevision
  )
}
