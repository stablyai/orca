import type {
  PtySourceCreditAck,
  PtySourceDeliveryIdentity,
  PtySourceSpan
} from '../../shared/pty-source-credit-contract'

export type SshPtySourceConsumerId = 'model' | 'desktop' | `remote:${string}`

export type SshPtySourceObligationState =
  | Readonly<{ state: 'open' }>
  | Readonly<{ state: 'transferring'; to: SshPtySourceConsumerId; reason: string }>
  | Readonly<{ state: 'settled'; reason: string }>
  | Readonly<{ state: 'transferred'; to: SshPtySourceConsumerId; reason: string }>
  | Readonly<{ state: 'canceled'; reason: string }>

export type SshPtySourceAdmissionReservation = Readonly<{
  reservationId: string
  span: PtySourceSpan
  requiredConsumers: readonly SshPtySourceConsumerId[]
}>

export type SshPtySourceTokenSnapshot = PtySourceDeliveryIdentity &
  Readonly<{
    state: 'active' | 'sealed-unsettled' | 'canceling' | 'closed'
    receivedEndSu: number
    obligationsTerminalEndSu: number
    ackQueuedEndSu: number
    ackPublishedEndSu: number
    openSpans: number
    exitPublished: boolean
    generationClosed: boolean
  }>

export type SshPtySourceAckPublication = Readonly<{
  identity: PtySourceDeliveryIdentity
  ack: PtySourceCreditAck
  onSettled: (result: { ok: true } | { ok: false; error: Error }) => void
}>
