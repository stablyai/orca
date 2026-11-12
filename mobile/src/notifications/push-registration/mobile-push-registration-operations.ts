import type {
  MobilePushFilter,
  MobilePushRegisterInput
} from '../../../../src/shared/mobile-push-contract'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'
import type { MobilePushToken } from './push-token'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import {
  notificationUnreadReplySchema,
  pushRouteRegistrationSchema
} from './notification-reply-schema'

// Skip reconciliation refusals under catch(() => null): preserve stored route state until retry, with no screen requiring a host error.

export const pushRouteRegister = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.register-push-or-skip',
    method: 'notifications.registerPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-registration', pushRouteRegistrationSchema)
  })
)

export const pushRouteUnregister = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'notifications.unregister-push-or-skip',
    method: 'notifications.unregisterPush',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('push-unregistered', notificationUnreadReplySchema)
  })
)

const REQUEST_TIMEOUT_MS = 5_000

export async function sendRegister(
  client: UnvalidatedRpcRequestPort,
  token: MobilePushToken,
  filter: MobilePushFilter
): Promise<boolean> {
  const params: Omit<MobilePushRegisterInput, 'deviceId'> = {
    platform: token.platform,
    token: token.token,
    ...(token.apnsEnvironment ? { apnsEnvironment: token.apnsEnvironment } : {}),
    filter
  }
  const reply = await pushRouteRegister
    .request(client, params, { timeoutMs: REQUEST_TIMEOUT_MS, failWhenDisconnected: true })
    .catch(() => null)
  const registration = reply && pushRouteRegister.interpret(reply)
  if (!registration?.accepted) {
    return false
  }
  return registration.value?.registered === true
}

export async function sendUnregister(
  client: UnvalidatedRpcRequestPort,
  timeoutMs: number
): Promise<boolean> {
  const reply = await pushRouteUnregister
    .request(client, null, { timeoutMs, failWhenDisconnected: true })
    .catch(() => null)
  return reply !== null && pushRouteUnregister.interpret(reply).accepted
}
