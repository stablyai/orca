import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EventEmitter } from 'node:events'

/** A provider can be pending or hosted elsewhere; it is not necessarily a local ChildProcess. */
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
    rootAbsent?: boolean
    spawnAbsenceKnown?: boolean
    /** Resolves with a real root PID; startup rejection alone is not proof of exit. */
    ready?: Promise<void>
    /** Hosted roots are signalled by their owner's held child handle, never by a saved PID. */
    signalRoot?: (signal: NodeJS.Signals) => Promise<boolean>
  }

export async function signalProviderRoot(
  child: Pick<ProviderChild, 'kill' | 'signalRoot'>,
  signal: NodeJS.Signals
): Promise<boolean> {
  return child.signalRoot ? child.signalRoot(signal) : child.kill(signal)
}

export async function awaitProviderChildSpawn(child: ProviderChild): Promise<void> {
  if (child.ready) {
    await child.ready
    return
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

export function providerSpawnAbsenceKnown(
  child: Pick<ProviderChild, 'pid' | 'spawnAbsenceKnown'>
): boolean {
  return child.spawnAbsenceKnown ?? child.pid === undefined
}
