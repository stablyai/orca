import { isWslUncPath } from '../../shared/wsl-paths'
import type { TranscriptFileHandle } from './wsl-transcript-fs-access'
import {
  isWslTranscriptFsProcessHandle,
  snapshotWslTranscriptFsProcess
} from './wsl-transcript-fs-process-dispatch'
import type { WslTranscriptFileSnapshot } from './wsl-transcript-fs-process-protocol'
import { runWslTranscriptFsTask } from './wsl-transcript-fs-gate'
import { admitWslTranscriptPath } from './wsl-transcript-running-admission'

export function transcriptHandleSnapshot(
  handle: TranscriptFileHandle,
  path: string
): Promise<WslTranscriptFileSnapshot> {
  if ('sshTranscript' in handle) {
    return Promise.reject(new Error('JSONL snapshots require a local or WSL file handle'))
  }
  if (!isWslUncPath(path) && !isWslTranscriptFsProcessHandle(handle)) {
    return handle.stat({ bigint: true })
  }
  return runWslTranscriptFsTask(
    { operation: 'handleSnapshot', path, priority: 'scan', dedupe: false },
    async (signal) => {
      await admitWslTranscriptPath(path)
      return isWslTranscriptFsProcessHandle(handle)
        ? snapshotWslTranscriptFsProcess(handle, signal)
        : handle.stat({ bigint: true })
    }
  )
}
