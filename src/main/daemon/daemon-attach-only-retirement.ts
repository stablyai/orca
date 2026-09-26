import {
  classifyAttachOnlyKillError,
  trackAttachOnlyOrphanRisk
} from './daemon-attach-only-orphan-event'
import { retireAccidentalAttachOnlySpawn } from './daemon-attach-only-retire'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'

export async function refuseAttachOnlyAccidentalSpawn(
  protocolVersion: number,
  context: { requestedSessionId: string; operation: { ignoreNextExit: boolean } },
  incarnationId: string | undefined,
  client: { request: (type: string, payload: unknown) => Promise<unknown> }
): Promise<never> {
  context.operation.ignoreNextExit = true
  await retireAttachOnlyAccidentalSpawn(
    protocolVersion,
    context.requestedSessionId,
    incarnationId,
    client
  )
  throw new SessionNotFoundError(context.requestedSessionId)
}

export async function retireAttachOnlyAccidentalSpawn(
  protocolVersion: number,
  sessionId: string,
  incarnationId: string | undefined,
  client: { request: (type: string, payload: unknown) => Promise<unknown> }
): Promise<void> {
  if (!incarnationId) {
    console.error('[daemon] attach-only retire skipped; no kill-owned proof', { protocolVersion })
    trackAttachOnlyOrphanRisk({ protocolVersion, killErrorClass: 'unknown' })
    throw new TerminalSessionOwnerUnverifiedError(sessionId)
  }
  await retireUnexpectedAttachOnlySpawn(protocolVersion, sessionId, () =>
    client.request('killOwned', {
      sessionId,
      immediate: true,
      expectedIncarnationId: incarnationId
    })
  )
}

export async function retireUnexpectedAttachOnlySpawn(
  protocolVersion: number,
  sessionId: string,
  kill: () => Promise<unknown>
): Promise<void> {
  const retire = await retireAccidentalAttachOnlySpawn({
    kill: async () => {
      await kill()
    }
  })
  if (retire.ok || retire.error instanceof SessionNotFoundError) {
    return
  }
  const killErrorClass = classifyAttachOnlyKillError(retire.error)
  console.error(
    '[daemon] attach-only retire of accidental legacy spawn failed; orphan may remain',
    { protocolVersion, killErrorClass }
  )
  trackAttachOnlyOrphanRisk({ protocolVersion, killErrorClass })
  throw new TerminalSessionOwnerUnverifiedError(sessionId)
}
