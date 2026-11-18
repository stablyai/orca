import { transcriptFileStat } from '../transcript-filesystem/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../transcript-filesystem/wsl-transcript-fs-error'
import { transcriptWatcherPathIsRunning } from '../transcript-filesystem/wsl-transcript-watcher-running-guard'

export async function transcriptWatcherPathIsInstallable(
  filePath: string,
  signal?: AbortSignal
): Promise<boolean> {
  if (!(await transcriptWatcherPathIsRunning(filePath))) {
    return false
  }
  try {
    await transcriptFileStat(filePath, 'exact', signal)
    return true
  } catch (error) {
    if (error instanceof WslTranscriptFsError) {
      throw error
    }
    return false
  }
}
