import { abandonRemoteSessionScanOnCancel } from '../ai-vault/ai-vault-scan-cancellation'

/** Cleanup continues after a caller leaves; native retirement must never extend an IPC deadline. */
export async function withinSessionSearchDeadline<T>(
  work: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Could not complete session search operation')),
      10_000
    )
  })
  try {
    return await abandonRemoteSessionScanOnCancel(Promise.race([work, deadline]), signal)
  } finally {
    clearTimeout(timer)
  }
}
