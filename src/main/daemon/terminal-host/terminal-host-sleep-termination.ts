/** The exact live process a Sleep ends; the journal's bound Session. */
type SleepTerminationTarget = {
  readonly incarnationId: string
  readonly isAlive: boolean
  readonly isTerminating?: boolean
}

export type TerminalHostSleepTerminationRequest = {
  id: string
  expectedIncarnationId: string
  immediate: boolean
  /** Runs when this request's own reservation is taken, before the producer can exit. */
  onAccepted: () => void
}

export type TerminalHostSleepTermination =
  | { accepted: false; reason: 'exited' | 'terminating' }
  | {
      accepted: true
      /** Settles with the teardown, whether or not it ended the process. */
      completion: Promise<void>
      /** After completion: the signal was refused and no claim on the process remains. */
      refused: () => boolean
    }

/**
 * The ordinary teardown of one exact live Session, with the caller's immediate or graceful
 * intent. An unrelated teardown already in progress never becomes this Sleep's termination.
 */
export function beginTerminalHostSleepTermination(
  request: TerminalHostSleepTerminationRequest,
  deps: {
    session: SleepTerminationTarget
    kill: (
      id: string,
      options: { immediate: boolean; onReservationAccepted: () => void }
    ) => Promise<void>
  }
): TerminalHostSleepTermination {
  const { session } = deps
  if (!session.isAlive || session.incarnationId !== request.expectedIncarnationId) {
    return { accepted: false, reason: 'exited' }
  }
  // An in-progress teardown already claimed the process; joining it could escalate it.
  if (session.isTerminating) {
    return { accepted: false, reason: 'terminating' }
  }
  let accepted = false
  let completion: Promise<void>
  try {
    completion = deps.kill(request.id, {
      immediate: request.immediate,
      onReservationAccepted: () => {
        accepted = true
        request.onAccepted()
      }
    })
  } catch (error) {
    // A root signal refused synchronously, after the reservation it already reported.
    completion = Promise.reject(error)
  }
  const settled = completion.then(
    () => {},
    () => {}
  )
  if (!accepted) {
    return { accepted: false, reason: 'terminating' }
  }
  return {
    accepted: true,
    completion: settled,
    // After the teardown settled, a reset claim on a live process means its signal was refused.
    refused: () => session.isAlive && !session.isTerminating
  }
}
