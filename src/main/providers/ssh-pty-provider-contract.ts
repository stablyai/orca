import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TerminalModes } from '../../shared/terminal-modes'

export type RemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  credentialFile?: string
  pathDelimiter?: ':' | ';'
}

export type SshPtyDataCallback = (payload: {
  id: string
  data: string
  providerGeneration: number
  ptyIncarnation: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
  source?: Readonly<{
    relayPtyId: string
    spanId: string
    clientGeneration: number
    ownerGeneration: number
    deliveryToken: string
    sourceStartSu: number
    sourceEndSu: number
  }>
  sourceMalformed?: boolean
  sourceRejected?: boolean
  rejectedSourceRecovery?: 'confirm-existing' | 'fresh-activation' | 'reconnect-channel'
}) => void
export type SshPtyReplayCallback = (payload: {
  id: string
  data: string
  /** Application terminal modes at the replay boundary, when the relay provides them. */
  modes?: TerminalModes
}) => void
export type SshPtyExitCallback = (payload: {
  id: string
  code: number
  providerGeneration: number
  ptyIncarnation: string
  incarnationId?: PtyIncarnationId
}) => void

export type SshPtyDeliveryPauseAdapter = (args: {
  id: string
  providerGeneration: number
  paused: boolean
}) => void
