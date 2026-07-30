import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import type {
  SshPtyDataCallback,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'
import { parseSshPtySourceFrame } from './ssh-pty-source-frame'
import {
  SshPtySourceDeliveryLedger,
  type PendingSshPtySourceData
} from './ssh-pty-source-delivery-ledger'

export type { SshPtyDataCallback, SshPtyExitCallback, SshPtyReplayCallback }
export type SshPtyRecoveryActivationLease = Readonly<{
  commit: () => void
  retire: () => void
}>
export type SshPtyReceivingActivationLease = Readonly<{
  commit: () => void
  rollback: () => Promise<boolean>
  transferToRecovery: (sink: SshPtyDataCallback) => SshPtyRecoveryActivationLease
}>

export type SshPtyNotificationSubscription = Readonly<{
  dispose: () => void
  installReceivingActivation: (
    relayPtyId: string,
    activation: PtySourceReceivingActivation
  ) => SshPtyReceivingActivationLease
}>

export function subscribeSshPtyNotifications(args: {
  mux: SshChannelMultiplexer
  toAppPtyId: (id: string) => string
  dataListeners: Set<SshPtyDataCallback>
  replayListeners: Set<SshPtyReplayCallback>
  exitListeners: Set<SshPtyExitCallback>
  livePtyIds: Set<string>
  recordExit: (relayPtyId: string, incarnationId: unknown) => void
  providerGeneration: number
  resolvePtyIncarnation: (relayPtyId: string, incarnationId?: unknown) => string
}): SshPtyNotificationSubscription {
  const toDataPayload = (pending: PendingSshPtySourceData): Parameters<SshPtyDataCallback>[0] => {
    const id = args.toAppPtyId(pending.relayPtyId)
    const ptyIncarnation = pending.source
      ? (pending.params.ptyIncarnation as string)
      : args.resolvePtyIncarnation(pending.relayPtyId, pending.params.incarnationId)
    return {
      id,
      data: pending.data,
      providerGeneration: args.providerGeneration,
      ptyIncarnation,
      ...(typeof pending.params.rawLength === 'number'
        ? { sequenceChars: pending.params.rawLength }
        : {}),
      ...(pending.params.transformed === true ? { transformed: true } : {}),
      ...(typeof pending.params.seq === 'number' ? { seq: pending.params.seq } : {}),
      ...(pending.source ? { source: pending.source } : {})
    }
  }
  const publishData = (pending: PendingSshPtySourceData): void => {
    const payload = toDataPayload(pending)
    args.livePtyIds.add(payload.id)
    for (const listener of args.dataListeners) {
      listener(payload)
    }
  }
  const sourceDeliveries = new SshPtySourceDeliveryLedger(args.mux, publishData)
  const dispose = args.mux.onNotification((method, params) => {
    // Why: mux delivers every method to generic handlers; non-PTY payloads
    // (workspace.changed, fs.changed, …) have no `id` and must not reach
    // toAppPtyId → startsWith.
    if (method !== 'pty.exit' && method !== 'pty.data' && method !== 'pty.replay') {
      return
    }
    if (typeof params.id !== 'string' || params.id.length === 0) {
      return
    }
    const relayPtyId = params.id
    if (method === 'pty.exit') {
      const id = args.toAppPtyId(relayPtyId)
      const ptyIncarnation = args.resolvePtyIncarnation(relayPtyId, params.incarnationId)
      args.recordExit(relayPtyId, params.incarnationId)
      args.livePtyIds.delete(id)
      sourceDeliveries.recordExit(relayPtyId)
      for (const listener of args.exitListeners) {
        listener({
          id,
          code: params.code as number,
          providerGeneration: args.providerGeneration,
          ptyIncarnation,
          ...(isPtyIncarnationId(params.incarnationId)
            ? { incarnationId: params.incarnationId }
            : {})
        })
      }
      return
    }
    if (method === 'pty.replay') {
      const id = args.toAppPtyId(relayPtyId)
      args.livePtyIds.add(id)
      for (const listener of args.replayListeners) {
        listener({ id, data: params.data as string })
      }
      return
    }
    const data = typeof params.data === 'string' ? params.data : ''
    const sourceFrame = parseSshPtySourceFrame(params, data, relayPtyId)
    if (sourceFrame.malformed) {
      cancelExactSourceDelivery(args.mux, relayPtyId, params)
      return
    }
    const pending = Object.freeze({
      relayPtyId,
      params,
      data,
      source: sourceFrame.source
    })
    if (sourceFrame.source) {
      if (!sourceDeliveries.admit({ ...pending, source: sourceFrame.source })) {
        cancelExactSourceDelivery(args.mux, relayPtyId, params)
      }
      return
    }
    publishData(pending)
  })
  return Object.freeze({
    dispose,
    installReceivingActivation: (relayPtyId, activation) => {
      const lease = sourceDeliveries.install(relayPtyId, activation)
      return Object.freeze({
        commit: lease.commit,
        rollback: lease.rollback,
        transferToRecovery: (sink: SshPtyDataCallback) =>
          lease.transferToRecovery((pending) => sink(toDataPayload(pending)))
      })
    }
  })
}

function cancelExactSourceDelivery(
  mux: SshChannelMultiplexer,
  relayPtyId: string,
  params: {
    deliveryToken?: unknown
    clientGeneration?: unknown
    ownerGeneration?: unknown
  }
): void {
  if (
    typeof params.deliveryToken !== 'string' ||
    params.deliveryToken.length === 0 ||
    !positiveSafeInteger(params.clientGeneration) ||
    !positiveSafeInteger(params.ownerGeneration)
  ) {
    return
  }
  try {
    void mux
      .request('pty.cancelDelivery', {
        id: relayPtyId,
        clientGeneration: params.clientGeneration,
        ownerGeneration: params.ownerGeneration,
        deliveryToken: params.deliveryToken
      })
      .catch(() => {})
  } catch {}
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
