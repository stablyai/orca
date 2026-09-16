// @ts-nocheck -- mechanically split declarations.
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
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
}): { unsubscribe: () => Promise<void> } {
  const key = runtimeWatcherReleaseKey(args.runtimeId, args.connectionId, args.rootPath)
  let currentUnwatch = args.initialUnwatch
  let stopped = false
  let reinstalling: Promise<void> | null = null

  const reinstall = async (): Promise<void> => {
    const provider = getSshFilesystemProvider(args.connectionId)
    if (stopped || !provider) {
      return
    }
    // Why: the old handle is scoped to the dead transport; closing it here would only risk
    // unwatching the root we just re-registered on the new one.
    const nextUnwatch = await provider.watch(args.rootPath, args.callback, {
      signal: args.signal,
      onTerminalError: args.onTerminalError
    })
    if (stopped) {
      nextUnwatch()
      return
    }
    currentUnwatch = nextUnwatch
    args.callback([{ kind: 'overflow', absolutePath: args.rootPath }])
  }

  const unsubscribeRearm = onSshFilesystemProviderRegistered((registeredId) => {
    if (registeredId !== args.connectionId || stopped) {
      return
    }
    // Why: reconnect storms can register repeatedly; chain so a second one can't double-install.
    const attempt = (reinstalling ?? Promise.resolve())
      .then(reinstall)
      .catch((error: unknown) => {
        args.onTerminalError(error instanceof Error ? error : new Error(String(error)))
      })
      .finally(() => {
        if (reinstalling === attempt) {
          reinstalling = null
        }
      })
    reinstalling = attempt
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

  return {
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
