export class RuntimeUploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'RuntimeUploadCancelledError'
  }
}

export function isRuntimeUploadCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === 'RuntimeUploadCancelledError'
}

const controllers = new Map<string, AbortController>()
// Why: a drop's files stream one at a time, so cancel can land between two of
// them. Remembering the id means the next file aborts instead of the click
// silently doing nothing.
const cancelled = new Set<string>()

/** Registers an upload so it can be cancelled; returns its release callback. */
export function registerCancellableUpload(uploadId: string): {
  signal: AbortSignal
  release: () => void
} {
  const controller = new AbortController()
  if (cancelled.has(uploadId)) {
    controller.abort()
  }
  controllers.set(uploadId, controller)
  return {
    signal: controller.signal,
    release: () => {
      if (controllers.get(uploadId) === controller) {
        controllers.delete(uploadId)
      }
    }
  }
}

export function cancelRuntimeUpload(uploadId: string): void {
  cancelled.add(uploadId)
  controllers.get(uploadId)?.abort()
}

/** Called once a drop is finished so a reused id cannot inherit a stale cancel. */
export function forgetRuntimeUploadCancellation(uploadId: string): void {
  cancelled.delete(uploadId)
  controllers.delete(uploadId)
}

export function isUploadCancelled(uploadId: string): boolean {
  return cancelled.has(uploadId)
}
