import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { PtyDataEvent } from './pty-provider-events'

export type RemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  pathDelimiter?: ':' | ';'
}

export type SshPtyDataCallback = (payload: PtyDataEvent) => void
export type SshPtyReplayCallback = (payload: { id: string; data: string }) => void
export type SshPtyExitCallback = (payload: {
  id: string
  code: number
  incarnationId?: PtyIncarnationId
}) => void
