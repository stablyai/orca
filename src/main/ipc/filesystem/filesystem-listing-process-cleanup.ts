import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { killSpawnedRipgrepProcess } from '../../../shared/ripgrep-process-availability'

export type FilesystemListingProcess = {
  child: ChildProcessHandle
  isDone: () => boolean
  finish: (error?: Error) => void
}

export function finishFilesystemListingProcesses(
  children: readonly FilesystemListingProcess[],
  error?: Error
): void {
  for (const entry of children) {
    if (entry.isDone()) {
      continue
    }
    entry.finish(error)
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      killSpawnedRipgrepProcess(entry.child)
    }
  }
}
