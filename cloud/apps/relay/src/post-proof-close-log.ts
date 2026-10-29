import { AssignmentRejectionLogWindow } from './assignment/assignment-rejection-log-window.js'
import { printableCloseReason } from './control-close-reason-text.js'
import { relayHostLogDigest } from './relay-host-log-digest.js'
import type { RelayRuntimeObserver } from './relay-observability.js'

// A looping host hits a post-proof close about once a second; per reason and
// cause, one line opens the window and one closing line carries the rest.
export const POST_PROOF_CLOSE_LOG_WINDOW_MS = 60_000

// Why the assignment check failed: the close reason alone cannot tell a moved
// assignment from a database timeout. Never the raw message (pg errors carry URLs).
export type PostProofCloseCause = 'wrong_assignment' | 'database_transient' | 'error'

export type PostProofClose = {
  relayHostId: string
  generation: number
  appVersion: string
  // Null when the host hung up itself: the cell sent no close frame.
  code: number | null
  reason: string
  cause?: PostProofCloseCause
}

// Controls closed between host proof and wiring never reach the 'control closed' listener.
export class PostProofCloseLog {
  private readonly window: AssignmentRejectionLogWindow<PostProofClose>

  constructor(
    private readonly observer: RelayRuntimeObserver,
    private readonly warn: (line: string) => void = (line) => console.warn(line),
    schedule?: (callback: () => void, delayMs: number) => () => void
  ) {
    this.window = new AssignmentRejectionLogWindow<PostProofClose>({
      windowMs: POST_PROOF_CLOSE_LOG_WINDOW_MS,
      onWindowClosed: ({ suppressed, sample }) => this.warn(formatLine(sample, suppressed)),
      schedule
    })
  }

  record(close: PostProofClose): void {
    this.observer.recordPostProofClose?.(close.reason)
    if (!this.window.admit(`${close.reason}:${close.cause ?? ''}`, close)) return
    this.warn(formatLine(close, 0))
  }
}

export function postProofCloseCause(
  error: unknown,
  isTransient: (error: unknown) => boolean
): PostProofCloseCause {
  if (error instanceof Error && error.message === 'wrong_assignment') return 'wrong_assignment'
  return isTransient(error) ? 'database_transient' : 'error'
}

function formatLine(close: PostProofClose, suppressed: number): string {
  return (
    `[orca-relay] control refused after proof host=${relayHostLogDigest(close.relayHostId)}` +
    ` gen=${close.generation}` +
    ` app=${JSON.stringify(printableCloseReason(close.appVersion))}` +
    ` code=${close.code ?? 'none'} reason=${JSON.stringify(close.reason)}` +
    (close.cause ? ` cause=${close.cause}` : '') +
    // Closing line only: how many more closes the window held back; the fields name the latest.
    (suppressed > 0 ? ` suppressed=${suppressed}` : '')
  )
}
