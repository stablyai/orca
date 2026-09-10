import { isWslUncPath } from '../../shared/wsl-paths'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import {
  createTranscriptNativeWatcher,
  type TranscriptNativeWatcher
} from './transcript-native-watcher'

export function isWslTranscriptWatcherPath(filePath: string): boolean {
  return isWslUncPath(filePath)
}

export async function transcriptWatcherPathIsRunning(filePath: string): Promise<boolean> {
  return (
    !isWslTranscriptWatcherPath(filePath) ||
    (await filterPathsToRunningWslDistrosAsync([filePath])).length > 0
  )
}

export function createRunningGuardedTranscriptNativeWatcher(
  filePath: string,
  onEvent: () => void,
  onRetry: () => void
): TranscriptNativeWatcher {
  const isWslPath = isWslTranscriptWatcherPath(filePath)
  if (isWslPath) {
    return {
      bind: () => false,
      dispose: () => {},
      invalidate: () => {},
      needsRebind: () => false
    }
  }
  let watcher: TranscriptNativeWatcher
  watcher = createTranscriptNativeWatcher(
    filePath,
    () => {
      if (!watcher.needsRebind()) {
        onEvent()
      }
    },
    () => {
      onRetry()
    }
  )
  return watcher
}
