import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import type {
  SshPtyDataCallback,
  SshPtyExitCallback,
  SshPtyReplayCallback
} from './ssh-pty-provider-contract'
import { parseSshPtySourceFrame } from './ssh-pty-source-frame'
import { SshPtySourceDeliveryLedger } from './ssh-pty-source-delivery-ledger'
import type {
  PendingSshPtySourceData,
  SshPtyRejectedSourceRecovery
} from './ssh-pty-source-delivery-state'

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
  rejectedDataListeners?: Set<SshPtyDataCallback>
  replayListeners: Set<SshPtyReplayCallback>
  exitListeners: Set<SshPtyExitCallback>
  livePtyIds: Set<string>
  recordExit: (relayPtyId: string, incarnationId: unknown) => void
  providerGeneration: number
  resolvePtyIncarnation: (relayPtyId: string, incarnationId?: unknown) => string
  peekPtyIncarnation: (relayPtyId: string) => string | undefined
}): SshPtyNotificationSubscription {
  const toDataPayload = (
    pending: PendingSshPtySourceData,
    incarnationOverride?: string
  ): Parameters<SshPtyDataCallback>[0] => {
    const id = args.toAppPtyId(pending.relayPtyId)
    const ptyIncarnation =
      incarnationOverride ??
      (pending.source
        ? (pending.params.ptyIncarnation as string)
        : args.resolvePtyIncarnation(pending.relayPtyId, pending.params.incarnationId))
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
  // Why: a rejected frame is diagnostic and must never mint an incarnation. resolvePtyIncarnation
  // caches what it synthesizes and rememberPtyIncarnation is first-write-wins, so a malformed frame
  // that lands before the PTY's first good one would pin a `legacy:` id the real attach can never
  // displace — fencing every later frame of that generation off as a mismatch.
  const rejectedPtyIncarnation = (pending: PendingSshPtySourceData): string => {
    const offered = pending.params.ptyIncarnation
    if (typeof offered === 'string' && offered.length > 0) {
      return offered
    }
    return args.peekPtyIncarnation(pending.relayPtyId) ?? ''
  }
  const publishRejectedData = (
    pending: PendingSshPtySourceData,
    rejection: 'malformed' | 'unadmitted',
    recovery: SshPtyRejectedSourceRecovery
  ): void => {
    const listeners = args.rejectedDataListeners
    if (!listeners || listeners.size === 0) {
      return
    }
    const payload = {
      ...toDataPayload(pending, rejectedPtyIncarnation(pending)),
      ...(rejection === 'malformed' ? { sourceMalformed: true } : {}),
      ...(rejection === 'unadmitted' ? { sourceRejected: true } : {}),
      rejectedSourceRecovery: recovery
    }
    for (const listener of listeners) {
      listener(payload)
    }
  }
  const sourceDeliveries = new SshPtySourceDeliveryLedger(args.mux, publishData)
  const rejectedPublications = new Map<
    string,
    {
      pending: number
      payload: PendingSshPtySourceData
      rejection: 'malformed' | 'unadmitted'
      recovery?: SshPtyRejectedSourceRecovery
    }
  >()
  const rejectSourceData = (
    pending: PendingSshPtySourceData,
    rejection: 'malformed' | 'unadmitted'
  ): void => {
    const batch = rejectedPublications.get(pending.relayPtyId) ?? {
      pending: 0,
      payload: pending,
      rejection
    }
    batch.pending++
    rejectedPublications.set(pending.relayPtyId, batch)
    void sourceDeliveries
      .reject(pending.relayPtyId, rejectedSourceIdentity(pending.params))
      .then((recovery) => {
        if (
          !batch.recovery ||
          rejectedRecoveryPriority(recovery) > rejectedRecoveryPriority(batch.recovery)
        ) {
          batch.payload = pending
          batch.rejection = rejection
          batch.recovery = recovery
        }
      })
      .finally(() => {
        batch.pending--
        queueMicrotask(() => {
          if (batch.pending > 0 || rejectedPublications.get(pending.relayPtyId) !== batch) {
            return
          }
          rejectedPublications.delete(pending.relayPtyId)
          publishRejectedData(batch.payload, batch.rejection, batch.recovery ?? 'reconnect-channel')
        })
      })
  }
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
      rejectedPublications.delete(relayPtyId)
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
      const pending = Object.freeze({ relayPtyId, params, data })
      rejectSourceData(pending, 'malformed')
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
        rejectSourceData(pending, 'unadmitted')
      }
      return
    }
    publishData(pending)
  })
  return Object.freeze({
    dispose: () => {
      rejectedPublications.clear()
      dispose()
    },
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

function rejectedRecoveryPriority(recovery: SshPtyRejectedSourceRecovery): number {
  if (recovery === 'reconnect-channel') {
    return 3
  }
  return recovery === 'fresh-activation' ? 2 : 1
}

function rejectedSourceIdentity(params: {
  deliveryToken?: unknown
  clientGeneration?: unknown
  ownerGeneration?: unknown
  ptyIncarnation?: unknown
}):
  | Readonly<{
      deliveryToken: string
      clientGeneration: number
      ownerGeneration: number
      ptyIncarnation: string
    }>
  | undefined {
  if (
    typeof params.deliveryToken !== 'string' ||
    params.deliveryToken.length === 0 ||
    !positiveSafeInteger(params.clientGeneration) ||
    !positiveSafeInteger(params.ownerGeneration) ||
    typeof params.ptyIncarnation !== 'string' ||
    params.ptyIncarnation.length === 0
  ) {
    return undefined
  }
  return Object.freeze({
    deliveryToken: params.deliveryToken,
    clientGeneration: params.clientGeneration,
    ownerGeneration: params.ownerGeneration,
    ptyIncarnation: params.ptyIncarnation
  })
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}
