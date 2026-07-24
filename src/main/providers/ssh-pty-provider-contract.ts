import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export type RemoteCliBridgeEnv = {
  binDir: string
  relayDir: string
  nodePath: string
  sockPath: string
  pathDelimiter?: ':' | ';'
}

export type SshPtyDataCallback = (payload: {
  id: string
  data: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
}) => void
export type SshPtyReplayCallback = (payload: { id: string; data: string }) => void
export type SshPtyExitCallback = (payload: {
  id: string
  code: number
  incarnationId?: PtyIncarnationId
}) => void
