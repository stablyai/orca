import type {
  StructuredAgentSessionAttachContext,
  StructuredAgentSessionAttachOptions
} from './structured-agent-session-attach-context'
import type { StructuredAgentSessionAttachLock } from './structured-agent-session-attach-lock'

export async function readAttachTelemetryCaller(
  context: StructuredAgentSessionAttachContext,
  sessionId: string,
  options: StructuredAgentSessionAttachOptions,
  lock: StructuredAgentSessionAttachLock
): Promise<string | undefined> {
  let telemetryCaller = options.telemetryCallerKey
  if (options.startedFor) {
    const submission = await lock.wait(
      context.sessions.get(sessionId)?.journal.reads.submission(options.startedFor) ??
        Promise.resolve(undefined)
    )
    telemetryCaller = undefined
    for (const id of [submission?.clientMessageId, submission?.queuedMessageId]) {
      if (!id) {
        continue
      }
      const read = await lock.wait(
        context.deps.journalDatabase.readCommandReceipt({ kind: 'global' }, id)
      )
      if (
        read.verdict === 'readable' &&
        read.receipt.status === 'accepted' &&
        read.receipt.sessionId === sessionId &&
        ['agentSession.create', 'agentSession.send', 'agentSession.queuedMessageSend'].includes(
          read.receipt.method
        )
      ) {
        telemetryCaller = read.receipt.callerKey
        break
      }
    }
  }
  return telemetryCaller
}
