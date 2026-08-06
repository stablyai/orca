import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export type DaemonPtyRouterDataEvent = {
  id: string
  data: string
  sequenceChars?: number
  transformed?: boolean
  seq?: number
}

export type DaemonPtyRouterExitEvent = {
  id: string
  code: number
  incarnationId?: PtyIncarnationId
}
