import { lstat, realpath } from 'node:fs/promises'
import { watchFileAcrossReplacement } from '../ipc/filesystem/watcher-process/native-subscriptions/rebinding-file-watch'
import type { RebindingFileWatch } from '../ipc/filesystem/watcher-process/native-subscriptions/rebinding-file-watch'
import type { WatchSettingsFile } from './settings-file-sync-types'

export type SettingsFileWatching = {
  /** Re-resolves the symlink target and rebinds its watch when it moved. */
  rebindTarget: () => Promise<void>
  /** Re-stats the link path so a newly created file gets watched and reported. */
  refreshLink: () => Promise<void>
  close: () => Promise<void>
}

export function createSettingsFileWatching(args: {
  filePath: string
  watchFile?: WatchSettingsFile
  onChange: () => void
  onError: (error: Error) => void
}): SettingsFileWatching {
  const watchFile = args.watchFile ?? watchFileAcrossReplacement
  const linkWatch = watchFile(args.filePath, args.onChange, args.onError)
  let targetPath: string | null = null
  let targetWatch: RebindingFileWatch | null = null
  let closed = false
  // Rebinds run one at a time so overlapping calls cannot each open a watch and leak one.
  let rebinding: Promise<void> = Promise.resolve()

  const closeTarget = async (): Promise<void> => {
    const current = targetWatch
    targetWatch = null
    targetPath = null
    await current?.close()
  }

  const rebindOnce = async (): Promise<void> => {
    let nextTarget: string | null = null
    try {
      // The link's own watch already covers a regular file.
      if ((await lstat(args.filePath)).isSymbolicLink()) {
        nextTarget = await realpath(args.filePath)
      }
    } catch {
      nextTarget = null
    }
    if (closed || nextTarget === targetPath) {
      return
    }
    await closeTarget()
    if (nextTarget !== null && !closed) {
      targetPath = nextTarget
      targetWatch = watchFile(nextTarget, args.onChange, args.onError)
    }
  }

  return {
    rebindTarget: () => {
      const run = rebinding.then(rebindOnce)
      rebinding = run.catch(() => {})
      return run
    },
    refreshLink: () => linkWatch.refresh(),
    close: async () => {
      closed = true
      await rebinding
      await closeTarget()
      await linkWatch.close()
    }
  }
}
