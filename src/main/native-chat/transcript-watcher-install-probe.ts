import { wslGatedStat } from './wsl-transcript-fs-access'
import { WslTranscriptFsError } from './wsl-transcript-fs-gate'
import { transcriptWatcherPathIsRunning } from './wsl-transcript-watcher-running-guard'

export async function transcriptWatcherPathIsInstallable(
  filePath: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!(await transcriptWatcherPathIsRunning(filePath))) {
    return false
  }
  try {
    await wslGatedStat(filePath, 'exact', signal)
    return true
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return false
  }
}
