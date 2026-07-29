export type DaemonQuitMode = 'disconnect' | 'shutdown'

export function resolveDaemonQuitMode(options: {
  platform: NodeJS.Platform
  updateQuitInProgress: boolean
  relaunchRequested: boolean
  devParentShutdownRequested: boolean
}): DaemonQuitMode {
  if (options.devParentShutdownRequested) {
    return 'shutdown'
  }
  if (options.updateQuitInProgress || options.relaunchRequested) {
    return 'disconnect'
  }
  return options.platform === 'win32' ? 'shutdown' : 'disconnect'
}

export async function shutdownAdoptedDaemonGenerations(options: {
  shutdownCurrent?: () => Promise<void>
  legacyProtocolVersions: readonly number[]
  shutdownLegacy: (protocolVersion: number) => Promise<void>
}): Promise<void> {
  const tasks: { label: string; promise: Promise<void> }[] = []
  if (options.shutdownCurrent) {
    tasks.push({ label: 'current', promise: options.shutdownCurrent() })
  }
  for (const protocolVersion of new Set(options.legacyProtocolVersions)) {
    tasks.push({
      label: `protocol-v${protocolVersion}`,
      promise: options.shutdownLegacy(protocolVersion)
    })
  }

  const results = await Promise.allSettled(tasks.map(({ promise }) => promise))
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [new Error(`Failed to shut down ${tasks[index].label}`, { cause: result.reason })]
      : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Daemon generation shutdown failed')
  }
}

export async function runGracefulDaemonShutdownWithFallback(options: {
  graceful: () => Promise<void>
  fallback: () => Promise<void>
  fallbackDelayMs: number
}): Promise<void> {
  let releaseFallback!: (run: boolean) => void
  let timer: ReturnType<typeof setTimeout> | undefined
  const fallbackGate = new Promise<boolean>((resolve) => {
    releaseFallback = resolve
    timer = setTimeout(() => resolve(true), options.fallbackDelayMs)
  })
  const gracefulResult = options.graceful().then(
    () => {
      clearTimeout(timer)
      releaseFallback(false)
      return null
    },
    (error: unknown) => {
      clearTimeout(timer)
      releaseFallback(true)
      return error
    }
  )
  const fallbackResult = fallbackGate.then(async (run) => {
    if (run) {
      await options.fallback()
    }
  })
  const [gracefulError, fallbackOutcome] = await Promise.all([
    gracefulResult,
    fallbackResult.then(
      () => null,
      (error: unknown) => error
    )
  ])
  if (fallbackOutcome) {
    throw new AggregateError(
      gracefulError ? [gracefulError, fallbackOutcome] : [fallbackOutcome],
      'Daemon fallback shutdown failed'
    )
  }
  if (gracefulError && !(await fallbackGate)) {
    throw gracefulError
  }
}
