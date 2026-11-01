type TeardownHost = {
  close(error?: Error): Promise<boolean>
  whenHandlersSettled(): Promise<void>
}

type TeardownExecutor = {
  close(): Promise<void>
}

type TeardownRouteSets = {
  close(error: Error): Promise<void>
}

export type BrowserClientHostCompositionTeardown = {
  host: TeardownHost
  executor: TeardownExecutor
  routeSets: TeardownRouteSets
  error: Error
  /** Lets whenClosed join executor cleanup deferred behind running handlers. */
  deferExecutorClose(close: Promise<void>): void
  reportCleanupError(error: Error): void
}

export function fenceBrowserClientHostComposition(
  routeSets: { fence(error: Error): void },
  executor: { fenceNavigation(): void },
  error: Error,
  reportCleanupError: (error: Error) => void
): void {
  routeSets.fence(error)
  try {
    executor.fenceNavigation()
  } catch (navigationError) {
    reportCleanupError(asCompositionError(navigationError))
  }
}

/** Returns whether handlers settled; executor cleanup waits for them to avoid stranding pages. */
export async function closeBrowserClientHostComposition(
  input: BrowserClientHostCompositionTeardown
): Promise<boolean> {
  const failures: unknown[] = []
  let handlersSettled = false
  try {
    handlersSettled = await input.host.close(input.error)
  } catch (hostError) {
    failures.push(hostError)
  }
  if (handlersSettled) {
    try {
      await input.executor.close()
    } catch (executorError) {
      failures.push(executorError)
    }
  } else {
    const deferred = input.host.whenHandlersSettled().then(() => input.executor.close())
    input.deferExecutorClose(deferred)
    void deferred.catch((cleanupError) =>
      input.reportCleanupError(asCompositionError(cleanupError))
    )
  }
  try {
    await input.routeSets.close(input.error)
  } catch (routeError) {
    failures.push(routeError)
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Browser client host composition cleanup failed')
  }
  return handlersSettled
}

export function asCompositionError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
