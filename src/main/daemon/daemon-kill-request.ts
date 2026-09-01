import type { PtyKillIntent } from '../../shared/pty-kill-sessions'

export type DaemonKillRequestPayload = {
  sessionId: string
  immediate?: boolean
  intent?: PtyKillIntent
  incarnationId?: string
}
