import { homedir } from 'node:os'
import {
  findGrokChatHistoryBySessionId,
  resolveGrokSessionsDir
} from '../../shared/grok-session-paths'
import type { AcpDriverOptions } from './acp-driver-options'

export async function publishGrokTranscriptPath(
  options: Pick<AcpDriverOptions, 'env'> & {
    sink: Pick<AcpDriverOptions['sink'], 'setTranscriptPath'>
  },
  sessionId: string
): Promise<void> {
  const sessionsDir = resolveGrokSessionsDir(
    options.env,
    options.env.HOME || options.env.USERPROFILE || homedir()
  )
  const path = await findGrokChatHistoryBySessionId(sessionsDir, sessionId).catch(() => null)
  if (path) {
    options.sink.setTranscriptPath(path)
  }
}
