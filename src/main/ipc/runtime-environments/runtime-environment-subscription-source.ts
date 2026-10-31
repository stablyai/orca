import {
  forwardedPushBinding,
  type ForwardedPushSource
} from '../../notifications/forwarded-push-authority'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime/remote-runtime-client'

export type RetainedRemoteRuntimeSubscription = RemoteRuntimeSubscription & {
  source?: ForwardedPushSource
  setupController: AbortController
  environmentId: string
  ownerWebContentsId: number
  disposeRendererLifetime: () => void
  notifyClosed: () => void
}
export type PendingRuntimeSubscription = {
  source?: ForwardedPushSource
  ownerWebContentsId: number
  environmentId: string
  close: () => void
}

export function invalidateSubscriptionSource(owner: { source?: ForwardedPushSource }): void {
  if (owner.source) {
    owner.source.invalid = true
  }
}

export function captureSubscriptionSource(
  owner: PendingRuntimeSubscription,
  root: string,
  method: string,
  selected: KnownRuntimeEnvironment,
  connection: PairedRuntimeConnection,
  live: boolean
): void {
  if (method !== 'agentSession.subscribeTurnCompletions') {
    return
  }
  if (!live || owner.source) {
    invalidateSubscriptionSource(owner)
    return
  }
  owner.source = {
    root,
    environmentId: selected.id,
    method,
    binding: forwardedPushBinding(selected, connection),
    invalid: false
  }
}

export function bindSubscriptionSource(
  owner: { source?: ForwardedPushSource },
  requestId: string
): ForwardedPushSource | undefined {
  const source = owner.source
  if (source) {
    if (source.requestId !== undefined && source.requestId !== requestId) {
      source.invalid = true
    } else {
      source.requestId = requestId
    }
  }
  return source
}

export function retainRuntimeSubscription(
  pending: PendingRuntimeSubscription,
  subscription: RemoteRuntimeSubscription,
  setupController: AbortController,
  disposeRendererLifetime: () => void,
  notifyClosed: () => void
): RetainedRemoteRuntimeSubscription {
  return {
    source: bindSubscriptionSource(pending, subscription.requestId),
    setupController,
    requestId: subscription.requestId,
    environmentId: pending.environmentId,
    ownerWebContentsId: pending.ownerWebContentsId,
    disposeRendererLifetime,
    notifyClosed,
    sendBinary: (bytes) => subscription.sendBinary(bytes),
    close: () => {
      invalidateSubscriptionSource(pending)
      disposeRendererLifetime()
      subscription.close()
    }
  }
}

export function findForwardedPushSource(
  pending: Map<string, PendingRuntimeSubscription>,
  retained: Map<string, RetainedRemoteRuntimeSubscription>,
  senderId: number,
  environmentId: string,
  context: { subscriptionId: string; requestId: string } | undefined
): { source: ForwardedPushSource; isCurrent: () => boolean } | undefined {
  if (
    !context ||
    typeof context.subscriptionId !== 'string' ||
    typeof context.requestId !== 'string'
  ) {
    return undefined
  }
  const id = context.subscriptionId
  const owner = pending.get(id) ?? retained.get(id)
  const source = owner?.source
  if (!owner || !source) {
    return undefined
  }
  const isCurrent = () =>
    (pending.get(id) ?? retained.get(id))?.source === source &&
    !source.invalid &&
    owner.ownerWebContentsId === senderId &&
    source.environmentId === environmentId &&
    source.method === 'agentSession.subscribeTurnCompletions' &&
    source.requestId === context.requestId
  return isCurrent() ? { source, isCurrent } : undefined
}
