import {
  openTranscriptReadStream,
  readTranscriptSlice
} from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import {
  isZstdTranscriptPath,
  readZstdTranscriptSlice,
  zstdTranscriptStream
} from '../../../native-chat/transcript-streaming/transcript-zstd-decompression'
import type { WslTranscriptFsTaskPriority } from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-gate'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'

const ROLLOUT_READ_LIMIT = 64 * 1024

/** The rollout's first-line session_meta record. Interactive resume uses exact priority; bulk AI Vault scans must not starve it. */
export async function readCodexRolloutSessionMeta(
  filePath: string,
  signal?: AbortSignal,
  priority: WslTranscriptFsTaskPriority = 'exact'
): Promise<Record<string, unknown> | null> {
  let head: Buffer
  try {
    // The transcript gate bounds stalled WSL reads; missing or pruned rollouts cannot abort a scan (#15453).
    head = isZstdTranscriptPath(filePath)
      ? await readZstdTranscriptSlice(
          zstdTranscriptStream(openTranscriptReadStream(filePath, {}, priority, signal)),
          ROLLOUT_READ_LIMIT
        )
      : await readTranscriptSlice(filePath, 0, ROLLOUT_READ_LIMIT, priority, signal)
  } catch (error) {
    // Preserve cancellation instead of treating it as an unreadable rollout.
    if (signal?.aborted) {
      throw error
    }
    return null
  }
  const firstLine = head.toString('utf8').split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) {
    return null
  }
  try {
    const record = asRecord(JSON.parse(firstLine))
    return record?.type === 'session_meta' ? record : null
  } catch {
    return null
  }
}

export async function readCodexRolloutSessionMetaId(
  filePath: string,
  signal?: AbortSignal,
  priority: WslTranscriptFsTaskPriority = 'exact'
): Promise<string | null> {
  const record = await readCodexRolloutSessionMeta(filePath, signal, priority)
  const payload = asRecord(record?.payload)
  const id =
    payload?.id ??
    payload?.session_id ??
    payload?.thread_id ??
    record?.id ??
    record?.session_id ??
    record?.thread_id
  return typeof id === 'string' && id.length > 0 ? id : null
}
