import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import type { DescendantTreeVerdict } from '../pty/process-retirement/pty-descendant-exit-verification'

export type ProviderChild = Pick<
  ChildProcessWithoutNullStreams,
  | 'pid'
  | 'stdin'
  | 'stdout'
  | 'stderr'
  | 'connected'
  | 'killed'
  | 'exitCode'
  | 'signalCode'
  | 'kill'
> &
  EventEmitter & {
    spawnAbsenceKnown?: boolean
    /** Actual CLI writer, which differs from the root on the compatibility path. */
    readonly writerPid?: number
    ready?: Promise<void>
    /** Group observation is independent of the real leader's outcome. */
    readonly groupVerdict?: DescendantTreeVerdict
    /** Prevent PID-based tree reads after the held OS root has actually exited. */
    readonly leaderExited?: boolean
  }

export async function awaitProviderChildSpawn(child: ProviderChild): Promise<void> {
  if (child.ready) {
    return child.ready
  }
  if (child.pid !== undefined) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      child.off('spawn', onSpawn)
      child.off('error', onError)
    }
    const onSpawn = (): void => {
      cleanup()
      resolve()
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    child.once('spawn', onSpawn)
    child.once('error', onError)
  })
}
