import { TerminalAttachCanceledError } from './daemon-errors'

/** Never resolves; only rejects, so it can bound a wait without settling it. */
export function rejectOnAbort(signal: AbortSignal | undefined, sessionId: string): Promise<never> {
  if (!signal) {
    return new Promise<never>(() => {})
  }
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new TerminalAttachCanceledError(sessionId))
      return
    }
    signal.addEventListener('abort', () => reject(new TerminalAttachCanceledError(sessionId)), {
      once: true
    })
  })
}
