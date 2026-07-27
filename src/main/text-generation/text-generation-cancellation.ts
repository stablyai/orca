export type TextGenerationOperation = 'commit-message' | 'pull-request-fields' | 'branch-name'

export const TEXT_GENERATION_CANCELED_RESULT = {
  success: false,
  error: 'Generation canceled.',
  canceled: true
} as const

export type TextGenerationCancellation = {
  isCanceled: () => boolean
  attach: (action: () => void) => () => void
  finish: () => void
  whenCanceled: Promise<void>
}

const activeCancellations = new Map<string, TextGenerationCancellationController>()

class TextGenerationCancellationController implements TextGenerationCancellation {
  private canceled = false
  private action: (() => void) | null = null
  private resolveCanceled: () => void = () => {}
  readonly whenCanceled = new Promise<void>((resolve) => {
    this.resolveCanceled = resolve
  })

  constructor(private readonly key: string) {}

  /** Reports whether the user has canceled this request. */
  isCanceled(): boolean {
    return this.canceled
  }

  /** Connects cancellation to a process action once the child exists. */
  attach(action: () => void): () => void {
    this.action = action
    if (this.canceled) {
      action()
    }

    /** Detaches only the action installed by this caller. */
    return () => {
      if (this.action === action) {
        this.action = null
      }
    }
  }

  /** Cancels once and resolves both pre-spawn and post-spawn observers. */
  cancel(): void {
    if (this.canceled) {
      return
    }
    this.canceled = true
    this.resolveCanceled()
    this.action?.()
  }

  /** Releases this controller without clearing a newer request in the lane. */
  finish(): void {
    if (activeCancellations.get(this.key) === this) {
      activeCancellations.delete(this.key)
    }
    this.action = null
  }
}

/** Builds an unambiguous registry key for one operation lane. */
function cancellationKey(operation: TextGenerationOperation, lane: string): string {
  return JSON.stringify([operation, lane])
}

/** Identifies a text-generation lane on the native or selected WSL host. */
export function localTextGenerationLane(cwd: string): string {
  return `local:${cwd}`
}

/** Identifies a text-generation lane on one SSH connection. */
export function sshTextGenerationLane(connectionId: string, cwd: string): string {
  return `ssh:${connectionId}:${cwd}`
}

/** Registers a cancelable request before its pre-spawn work begins. */
export function beginTextGenerationCancellation(
  operation: TextGenerationOperation,
  lane: string
): TextGenerationCancellation {
  const key = cancellationKey(operation, lane)
  const cancellation = new TextGenerationCancellationController(key)
  activeCancellations.set(key, cancellation)
  return cancellation
}

/** Cancels the active request for an operation lane, when present. */
export function cancelTextGeneration(operation: TextGenerationOperation, lane: string): void {
  activeCancellations.get(cancellationKey(operation, lane))?.cancel()
}

/** Settles a request immediately on cancellation while its guarded work unwinds. */
export async function runCancelableTextGenerationRequest<T>(
  operation: TextGenerationOperation,
  lane: string,
  canceledResult: T,
  run: (cancellation: TextGenerationCancellation) => Promise<T>
): Promise<T> {
  const cancellation = beginTextGenerationCancellation(operation, lane)
  const generation = run(cancellation)
  try {
    return await Promise.race([generation, cancellation.whenCanceled.then(() => canceledResult)])
  } finally {
    cancellation.finish()
  }
}
