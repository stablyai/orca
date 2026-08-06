import { isWatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'

type RuntimeRootWatchTeardown = {
  closed: boolean
  generation: number
  abortController: AbortController
  subscription: { unsubscribe(): Promise<void> } | null
  terminalReleaseError: Error | null
}

export async function closeRuntimeRootWatch(
  root: RuntimeRootWatchTeardown,
  pendingGeneration: Promise<void>,
  release: () => void,
  releaseAfterFailure: (error: Error) => void
): Promise<void> {
  if (root.closed) {
    if (root.terminalReleaseError) {
      throw root.terminalReleaseError
    }
    return
  }
  root.closed = true
  root.generation++
  root.abortController.abort()
  try {
    await pendingGeneration
  } catch (error) {
    if (!(isWatcherProcessFailure(error) && error.code === 'subscribe_aborted')) {
      if (error instanceof Error) {
        releaseAfterFailure(error)
      } else {
        release()
      }
      throw error
    }
  }
  try {
    await root.subscription?.unsubscribe()
    release()
  } catch (error) {
    if (error instanceof Error) {
      releaseAfterFailure(error)
    } else {
      release()
    }
    throw error
  }
}
