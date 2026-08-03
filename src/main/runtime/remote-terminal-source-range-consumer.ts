import type { TerminalOutputSourceRange } from '../../shared/terminal-output-source-range'

export type RemoteTerminalSourceRangeStreamIdentity = Readonly<{
  ptyId: string
  consumerId: string
  streamGeneration: string
}>

export type RemoteTerminalSourceRangeReplacementReservation = Readonly<{
  reservationId: string
  identity: RemoteTerminalSourceRangeStreamIdentity
  requiredSeq: number
}>

export type RemoteTerminalSourceRangeReplacementPublication = Readonly<{
  source: 'headless' | 'renderer'
  seq: number
}>

export type RemoteTerminalSourceRangeConsumerHooks = {
  attach: (identity: RemoteTerminalSourceRangeStreamIdentity) => boolean
  settle: (
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[]
  ) => void
  reserveReplacement: (
    identity: RemoteTerminalSourceRangeStreamIdentity,
    requiredSeq: number,
    reason: string
  ) => RemoteTerminalSourceRangeReplacementReservation | null
  commitReplacement: (
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    publication: RemoteTerminalSourceRangeReplacementPublication
  ) => boolean
  rollbackReplacement: (
    reservation: RemoteTerminalSourceRangeReplacementReservation,
    reason: string
  ) => boolean
  cancel: (
    identity: RemoteTerminalSourceRangeStreamIdentity,
    ranges: readonly TerminalOutputSourceRange[],
    reason: string
  ) => void
}
