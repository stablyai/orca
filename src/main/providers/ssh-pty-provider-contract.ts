import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'

export type RemoteCliBridgeEnv = {
  /** Probed at connect time; the execution host's home for launch-profile secondary homes. */
  remoteHome?: string
  hostPlatform?: RemoteHostPlatform
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
export type SshPtyReplayCallback = (payload: { id: string; data: string }) => void
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
