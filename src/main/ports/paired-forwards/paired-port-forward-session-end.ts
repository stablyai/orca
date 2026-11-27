import {
  endPairedPortForwardSession,
  pairedPortForwardSession
} from './paired-port-forward-sessions'
import { removePairedPortForward } from './paired-port-forwards'

const lifetimes = new Map<string, () => void>()

/** Ends a session's forwards; each closes in its server's queue unless a person adopted it first. */
export async function endPairedForwardSession(session: string): Promise<void> {
  lifetimes.get(session)?.()
  lifetimes.delete(session)
  await Promise.all(
    endPairedPortForwardSession(session).map(({ id, environmentId }) =>
      removePairedPortForward(id, {
        environmentId,
        when: () => pairedPortForwardSession(id) === session
      })
    )
  )
}

/** Ends `session` when `signal` aborts (its renderer reloaded, crashed or closed), so a window that
 *  never says goodbye leaves no forward behind. `dispose` lets go of what the signal watches. */
export function endPairedForwardSessionOnAbort(
  session: string,
  signal: AbortSignal,
  dispose: () => void
): void {
  if (lifetimes.has(session)) {
    dispose()
    return
  }
  const onAbort = (): void => void endPairedForwardSession(session)
  signal.addEventListener('abort', onAbort, { once: true })
  lifetimes.set(session, () => {
    signal.removeEventListener('abort', onAbort)
    dispose()
  })
  if (signal.aborted) {
    onAbort()
  }
}
