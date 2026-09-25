import type { spawnProcess } from '../../shared/child-process/run-process'

export type TailcatChild = ReturnType<typeof spawnProcess>

const DEFAULT_TERMINATE_GRACE_MS = 5_000

export function hasChildExited(child: TailcatChild): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

/**
 * Why: `spawnProcess` leaves stream `error` events to the caller, and an unhandled one is an uncaught
 * exception in the main process. tailcat owns no subprocesses, so no tree termination is needed.
 */
export function guardChildStreams(child: TailcatChild, logf?: (message: string) => void): void {
  const onStreamError = (error: Error): void => {
    logf?.(`[tailcat] child stream error: ${error.message}`)
  }
  child.stdout.on('error', onStreamError)
  child.stderr.on('error', onStreamError)
  child.stdin.on('error', onStreamError)
}

/** SIGTERM, then SIGKILL after `graceMs`; resolves once the child has exited either way. */
export function terminateChild(
  child: TailcatChild,
  graceMs: number = DEFAULT_TERMINATE_GRACE_MS
): Promise<void> {
  if (hasChildExited(child)) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const escalate = setTimeout(() => {
      if (!hasChildExited(child)) {
        child.kill('SIGKILL')
      }
    }, graceMs)
    child.once('exit', () => {
      clearTimeout(escalate)
      resolve()
    })
    child.kill()
  })
}
