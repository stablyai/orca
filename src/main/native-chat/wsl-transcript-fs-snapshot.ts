import { stat } from 'node:fs/promises'
import { isWslUncPath } from '../../shared/wsl-paths'
import type { TranscriptFileHandle } from './wsl-transcript-fs-access'
import { runWslTranscriptFsTask, type WslTranscriptFsTaskPriority } from './wsl-transcript-fs-gate'
import {
  isWslTranscriptFsProcessHandle,
  runWslTranscriptFsProcess,
  statWslTranscriptFsProcess
} from './wsl-transcript-fs-process-dispatch'
import type { TranscriptBigIntStat } from './wsl-transcript-fs-process-protocol'
import { wslTranscriptFsLaneKey } from './wsl-transcript-fs-route'

/** Preserve inode and nanosecond precision across the local child-process boundary. */
export function wslGatedBigIntStat(
  path: string,
  priority: WslTranscriptFsTaskPriority
): Promise<TranscriptBigIntStat> {
  if (!isWslUncPath(path)) {
    return stat(path, { bigint: true })
  }
  return runWslTranscriptFsTask({ operation: 'statBigInt', path, priority }, (signal) =>
    runWslTranscriptFsProcess<TranscriptBigIntStat>(
      { operation: 'statBigInt', path },
      signal,
      wslTranscriptFsLaneKey(path, priority)
    )
  )
}

export function wslGatedHandleStat(
  handle: TranscriptFileHandle,
  path: string,
  priority: WslTranscriptFsTaskPriority
): Promise<TranscriptBigIntStat> {
  if ('sshTranscript' in handle) {
    throw new Error('SSH transcript handles do not provide local JSONL snapshot identity')
  }
  if (!isWslUncPath(path) && !isWslTranscriptFsProcessHandle(handle)) {
    return handle.stat({ bigint: true })
  }
  return runWslTranscriptFsTask(
    { operation: 'fstatBigInt', path, priority, dedupe: false },
    (signal) =>
      isWslTranscriptFsProcessHandle(handle)
        ? statWslTranscriptFsProcess(handle, signal)
        : handle.stat({ bigint: true })
  )
}
