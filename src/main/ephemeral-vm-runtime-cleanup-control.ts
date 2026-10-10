import type { CleanupEphemeralVmRuntimeResult } from './ephemeral-vm-runtime-service'

type CleanupInFlight = {
  controller: AbortController
  promise: Promise<CleanupEphemeralVmRuntimeResult>
}

const cleanupInFlight = new Map<string, CleanupInFlight>()

export function runControlledEphemeralVmRuntimeCleanup(args: {
  userDataPath: string
  runtimeId: string
  signal?: AbortSignal
  run: (signal: AbortSignal) => Promise<CleanupEphemeralVmRuntimeResult>
}): Promise<CleanupEphemeralVmRuntimeResult> {
  const key = cleanupKey(args)
  const existing = cleanupInFlight.get(key)
  if (existing) {
    return existing.promise
  }

  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort()
  if (args.signal?.aborted) {
    forwardAbort()
  } else {
    args.signal?.addEventListener('abort', forwardAbort, { once: true })
  }
  const promise = args.run(controller.signal)
  const inFlight = { controller, promise }
  cleanupInFlight.set(key, inFlight)
  const forget = (): void => {
    args.signal?.removeEventListener('abort', forwardAbort)
    if (cleanupInFlight.get(key) === inFlight) {
      cleanupInFlight.delete(key)
    }
  }
  void promise.then(forget, forget)
  return promise
}

export function stopEphemeralVmRuntimeCleanup(args: {
  userDataPath: string
  runtimeId: string
}): Promise<CleanupEphemeralVmRuntimeResult> | null {
  const cleanup = cleanupInFlight.get(cleanupKey(args))
  if (!cleanup) {
    return null
  }
  cleanup.controller.abort()
  return cleanup.promise
}

function cleanupKey(args: { userDataPath: string; runtimeId: string }): string {
  return `${args.userDataPath}\0${args.runtimeId}`
}
