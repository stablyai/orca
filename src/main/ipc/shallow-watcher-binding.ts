import type { FSWatcher } from 'node:fs'

export type ShallowWatcherBinding = {
  identity: string | null
  close: () => Promise<void>
}

export function createShallowWatcherBinding(
  watcher: FSWatcher,
  identity: string | null,
  onTerminal: () => void,
  onError: (error: unknown) => void
): ShallowWatcherBinding {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let terminal = false
  let closing = false
  const finish = (): void => {
    if (terminal) {
      return
    }
    terminal = true
    resolve()
    onTerminal()
  }
  watcher.once('close', finish)
  watcher.on('error', (error) => {
    // Node closes its native handle before emitting error, without emitting close.
    finish()
    onError(error)
  })
  return {
    identity,
    close: () => {
      if (!terminal && !closing) {
        closing = true
        try {
          watcher.close()
        } catch (error) {
          // A throw alone does not prove the native handle was released.
          if (!terminal) {
            reject(error)
          }
        }
      }
      return promise
    }
  }
}
