import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import type { IFilesystemProvider } from '../providers/types'
import { toRemoteRuntimeClientErrorLike } from '../../shared/remote-runtime-client-error-classification'
import {
  runtimeWatcherReleaseKey,
  sshFileExplorerWatchRearms
} from './runtime-file-commands-mobile-file-list-limit'
import {
  getSshFilesystemProvider,
  onSshFilesystemProviderRegistered
} from '../providers/ssh-filesystem-dispatch'

export function armSshFileExplorerWatchRearm(args: {
  runtimeId: string
  connectionId: string
  rootPath: string
  callback: (events: FsChangeEvent[]) => void
  onTerminalError: (error: Error) => void
  signal?: AbortSignal
  initialUnwatch: () => void
  initialProvider: Pick<IFilesystemProvider, 'watch'>
}): {
  initialCallbacks: {
    callback: (events: FsChangeEvent[]) => void
    onTerminalError: (error: Error) => void
  }
  unsubscribe: () => Promise<void>
} {
  const key = runtimeWatcherReleaseKey(args.runtimeId, args.connectionId, args.rootPath)
  let currentUnwatch = args.initialUnwatch
  let currentProvider = args.initialProvider
  let stopped = false
  let reinstalling: Promise<void> | null = null
  let providerGeneration = 0

  const reportTerminalError = (error: unknown): void => {
    // Connection loss leaves the established stream armed for the next provider.
    if (toRemoteRuntimeClientErrorLike(error).code === 'CONNECTION_LOST') {
      return
    }
    args.onTerminalError(error instanceof Error ? error : new Error(String(error)))
  }

  const reinstall = async (
    generation: number,
    provider: Pick<IFilesystemProvider, 'watch'> | undefined
  ): Promise<void> => {
    if (stopped || generation !== providerGeneration || !provider) {
      return
    }
    const isCurrent = (): boolean =>
      !stopped &&
      !args.signal?.aborted &&
      generation === providerGeneration &&
      provider === getSshFilesystemProvider(args.connectionId)
    let nextUnwatch: () => void
    try {
      nextUnwatch = await provider.watch(
        args.rootPath,
        (events) => {
          if (isCurrent()) {
            args.callback(events)
          }
        },
        {
          signal: args.signal,
          onTerminalError: (error) => {
            if (isCurrent()) {
              reportTerminalError(error)
            }
          }
        }
      )
    } catch (error) {
      if (!isCurrent()) {
        return
      }
      throw error
    }
    if (!isCurrent()) {
      nextUnwatch()
      return
    }
    // Why: a dead transport's handle must never unwatch the replacement transport's root.
    if (currentProvider === provider) {
      currentUnwatch()
    }
    currentUnwatch = nextUnwatch
    currentProvider = provider
    args.callback([{ kind: 'overflow', absolutePath: args.rootPath }])
  }

  const scheduleReinstall = (): void => {
    if (stopped) {
      return
    }
    const generation = ++providerGeneration
    let attemptProvider: Pick<IFilesystemProvider, 'watch'> | undefined
    // Why: obsolete reconnect attempts cannot terminate the stream or publish a stale refresh.
    const attempt = (reinstalling ?? Promise.resolve())
      .then(() => {
        attemptProvider = getSshFilesystemProvider(args.connectionId)
        return reinstall(generation, attemptProvider)
      })
      .catch((error: unknown) => {
        if (
          !stopped &&
          !args.signal?.aborted &&
          generation === providerGeneration &&
          attemptProvider === getSshFilesystemProvider(args.connectionId)
        ) {
          reportTerminalError(error)
        }
      })
      .finally(() => {
        if (reinstalling === attempt) {
          reinstalling = null
        }
      })
    reinstalling = attempt
  }
  const unsubscribeRearm = onSshFilesystemProviderRegistered((registeredId) => {
    if (registeredId === args.connectionId) {
      scheduleReinstall()
    }
  })

  const stop = (): void => {
    stopped = true
    unsubscribeRearm()
    const rearms = sshFileExplorerWatchRearms.get(key)
    rearms?.delete(stop)
    if (rearms?.size === 0) {
      sshFileExplorerWatchRearms.delete(key)
    }
  }
  const rearms = sshFileExplorerWatchRearms.get(key) ?? new Set<() => void>()
  rearms.add(stop)
  sshFileExplorerWatchRearms.set(key, rearms)
  if (getSshFilesystemProvider(args.connectionId) !== args.initialProvider) {
    scheduleReinstall()
  }
  const isInitialCurrent = (): boolean =>
    !stopped &&
    !args.signal?.aborted &&
    providerGeneration === 0 &&
    args.initialProvider === getSshFilesystemProvider(args.connectionId)

  return {
    initialCallbacks: {
      callback: (events) => {
        if (isInitialCurrent()) {
          args.callback(events)
        }
      },
      onTerminalError: (error) => {
        if (isInitialCurrent()) {
          reportTerminalError(error)
        }
      }
    },
    unsubscribe: () => {
      stop()
      const close = async (): Promise<void> => currentUnwatch()
      // Why: awaiting an absent reinstall costs a microtask, and removal gating relies on the
      // unwatch being issued on the same turn the lease releases it.
      return reinstalling ? reinstalling.catch(() => undefined).then(close) : close()
    }
  }
}

export function stopSshFileExplorerWatchRearms(key: string): void {
  for (const stop of Array.from(sshFileExplorerWatchRearms.get(key) ?? [])) {
    stop()
  }
}
