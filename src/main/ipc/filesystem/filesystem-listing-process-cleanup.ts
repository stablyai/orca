import type { ChildProcess } from 'node:child_process'
import { killSpawnedRipgrepProcess } from '../../../shared/ripgrep/ripgrep-process-availability'

export type FilesystemListingProcess = {
  child: ChildProcess
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
