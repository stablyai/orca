export type TextGenerationOperation = 'commit-message' | 'pull-request-fields' | 'branch-name'

export type TextGenerationCancellation = {
  isCanceled: () => boolean
  attach: (action: () => void) => () => void
  finish: () => void
  whenCanceled: Promise<void>
}

const activeCancellations = new Map<string, () => void>()

function cancellationKey(operation: TextGenerationOperation, lane: string): string {
  return JSON.stringify([operation, lane])
}

export function localTextGenerationLane(cwd: string): string {
  return `local:${cwd}`
}

export function sshTextGenerationLane(connectionId: string, cwd: string): string {
  return `ssh:${connectionId}:${cwd}`
}

export function beginTextGenerationCancellation(
  operation: TextGenerationOperation,
  lane: string
): TextGenerationCancellation {
  const key = cancellationKey(operation, lane)
  let canceled = false
  let action: (() => void) | null = null
  let resolveCanceled = (): void => {}
  const whenCanceled = new Promise<void>((resolve) => {
    resolveCanceled = resolve
  })
  const cancel = (): void => {
    if (canceled) {
      return
    }
    canceled = true
    resolveCanceled()
    action?.()
  }
  activeCancellations.set(key, cancel)

  return {
    isCanceled: () => canceled,
    attach: (nextAction) => {
      action = nextAction
      if (canceled) {
        nextAction()
      }
      return () => {
        if (action === nextAction) {
          action = null
        }
      }
    },
    whenCanceled,
    finish: () => {
      // Why: an older request may finish after a newer request has claimed the same lane.
      if (activeCancellations.get(key) === cancel) {
        activeCancellations.delete(key)
      }
      action = null
    }
  }
}

export function cancelTextGeneration(operation: TextGenerationOperation, lane: string): void {
  activeCancellations.get(cancellationKey(operation, lane))?.()
}

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
