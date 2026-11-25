// Runs an agent CLI's own updater, stopping one that hangs without cutting off one that is slow.

import { runProcess, spawnProcess } from '@orca/process-host'

// One waiting on a prompt goes quiet; npm can also stay quiet while it installs, so this is generous.
export const UPDATER_IDLE_MS = 3 * 60_000
// A working update on a slow link can take minutes; past this it stops regardless.
export const UPDATER_MAX_MS = 10 * 60_000
// A child the updater left behind can hold its output open; its exit is what says it finished.
const AFTER_EXIT_MS = 5_000
const OUTPUT_BYTES = 64 * 1024

export type UpdaterRun = Awaited<ReturnType<typeof runProcess>> & {
  /** Why Orca stopped it, in the words the failure dialog shows; null when it ended on its own. */
  stoppedBecause: string | null
}

export async function runAgentCliUpdater(
  spec: {
    program: string
    args: readonly string[]
    cwd: string
    env: Record<string, string>
  },
  signal?: AbortSignal
): Promise<UpdaterRun> {
  const stop = new AbortController()
  let stoppedBecause: string | null = null
  let idle: ReturnType<typeof setTimeout> | undefined
  let afterExit: ReturnType<typeof setTimeout> | undefined
  const stopFor = (reason: string): void => {
    stoppedBecause ??= reason
    stop.abort()
  }
  const quiet = (): void => {
    clearTimeout(idle)
    idle = setTimeout(
      () => stopFor(`Stopped after ${UPDATER_IDLE_MS / 60_000} minutes without any output.`),
      UPDATER_IDLE_MS
    )
  }
  try {
    const result = await runProcess(
      {
        ...spec,
        args: [...spec.args],
        timeoutMs: UPDATER_MAX_MS,
        maxOutputBytes: OUTPUT_BYTES,
        terminationBarrier: signal ? 'wait-for-posix-group' : true,
        signal: signal ? AbortSignal.any([signal, stop.signal]) : stop.signal,
        // Spawned here, as runProcess would, so its output and exit can be watched as they happen.
        launch: (launchSpec) => {
          const child = spawnProcess(launchSpec)
          child.stdout?.on('data', quiet)
          child.stderr?.on('data', quiet)
          child.once('exit', () => {
            clearTimeout(idle)
            afterExit = setTimeout(
              () => stopFor('The updater exited but left a process holding its output.'),
              AFTER_EXIT_MS
            )
          })
          quiet()
          return { child, withdrawPendingLaunch: () => {} }
        }
      },
      'tail'
    )
    return {
      ...result,
      stoppedBecause: result.timedOut
        ? `Stopped after ${UPDATER_MAX_MS / 60_000} minutes without finishing.`
        : stoppedBecause
    }
  } finally {
    clearTimeout(idle)
    clearTimeout(afterExit)
  }
}
