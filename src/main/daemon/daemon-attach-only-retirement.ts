import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'

export async function retireUnexpectedAttachOnlySpawn(
  sessionId: string,
  retire: () => Promise<unknown>
): Promise<void> {
  try {
    await retire()
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return
    }
    console.warn('[daemon] attach-only retire of unexpected spawn failed', {
      sessionId,
      error
    })
    throw new TerminalSessionOwnerUnverifiedError(sessionId)
  }
}
