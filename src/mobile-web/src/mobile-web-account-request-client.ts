import {
  MobileWebAccountConsumeResetPayloadSchema,
  MobileWebAccountConsumeResetResultSchema,
  MobileWebAccountResetCapabilityPayloadSchema,
  MobileWebAccountResetCapabilityResultSchema,
  MobileWebAccountSelectPayloadSchema,
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
import { requestMobileWebHost } from './mobile-web-host-request-client'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'

function parseSnapshot(result: unknown): MobileWebAccountsSnapshot {
  const parsed = MobileWebAccountsSnapshotSchema.safeParse(result)
  if (!parsed.success) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return parsed.data
}

/** A WSL target needs the distro-aware method: an older host silently drops the target field from
 * `accounts.selectCodex` and would clear the host slot instead. */
function selectMethod(payload: MobileWebAccountSelectPayload): string {
  if (payload.provider === 'claude') {
    return 'accounts.selectClaude'
  }
  return payload.codexTarget?.runtime === 'wsl'
    ? 'accounts.selectCodexForTarget'
    : 'accounts.selectCodex'
}

export class MobileWebAccountRequestClient {
  constructor(
    private readonly requests: MobileWebOneShotRequestClient,
    private readonly subscriptions: MobileWebBridgeSubscriptionClient
  ) {}

  snapshot(): Promise<MobileWebAccountsSnapshot> {
    return requestMobileWebHost(this.requests, 'accounts.list', undefined, {
      refreshUsage: true
    }).then(parseSnapshot)
  }

  select(payload: MobileWebAccountSelectPayload): Promise<null> {
    if (!MobileWebAccountSelectPayloadSchema.safeParse(payload).success) {
      return Promise.reject(new MobileWebBridgeClientError('invalid_request', false))
    }
    const method = selectMethod(payload)
    return requestMobileWebHost(this.requests, method, undefined, {
      accountId: payload.accountId,
      ...(method === 'accounts.selectCodexForTarget' ? { target: payload.codexTarget } : {})
    }).then(() => null)
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
    return this.subscriptions.subscribeHost(
      { method: 'accounts.subscribe', params: {} },
      (event) => {
        const type =
          typeof event === 'object' && event !== null && 'type' in event ? event.type : undefined
        if (type === 'end' || type === 'error') {
          onEvent({ type })
          return
        }
        if (type !== 'ready' && type !== 'snapshot') {
          onError(new MobileWebBridgeClientError('invalid_message', false))
          return
        }
        try {
          onEvent({ type, snapshot: parseSnapshot((event as { snapshot: unknown }).snapshot) })
        } catch {
          onError(new MobileWebBridgeClientError('invalid_message', false))
        }
      },
      onError
    )
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
